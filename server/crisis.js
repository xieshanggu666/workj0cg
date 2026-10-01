import crypto from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import db, { ts, now } from './db.js'

// 跨角色危机处置审计：关键操作 / 授权变更 / 状态回退 按事件归集为只追加的 SHA-256 哈希链。
// 链条目与业务动作在同一 SQLite 事务内写入，DB 触发器禁止 UPDATE/DELETE，任何篡改都会在链校验中断裂。

const num = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d }

// 当前请求的操作人（由 index.js 的中间件放入 ALS），业务钩子无需层层透传即可拿到责任身份
const actorALS = new AsyncLocalStorage()
export function withActor(actor, fn) { return actorALS.run(actor || null, fn) }
export function ctxActor() { return actorALS.getStore() || null }

export const SEVERITY_LABEL = { P1: 'P1 重大', P2: 'P2 高', P3: 'P3 中' }
export const INCIDENT_STATUS_LABEL = {
  open: '待处置', investigating: '处置中', contained: '已控制', closed: '已结案'
}
export const CATEGORY_META = {
  key_op: { icon: '🔑', label: '关键操作' },
  authz_change: { icon: '🛡️', label: '授权变更' },
  rollback: { icon: '⏪', label: '状态回退' }
}

// 稳定序列化：排序键 + 无多余空白，保证哈希可复算（与 JSON.stringify 的键顺序解耦）
function stable(value) {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(stable)
  return Object.keys(value).sort().reduce((o, k) => { o[k] = stable(value[k]); return o }, {})
}
function canonical(value) { return JSON.stringify(stable(value ?? {})) }

function hashOf(prev, header, detail) {
  return crypto.createHash('sha256')
    .update(prev || 'GENESIS')
    .update('|').update(canonical(header))
    .update('|').update(canonical(detail))
    .digest('hex')
}

function actorOf(actor, fallbackName = '') {
  const ctx = ctxActor()
  return {
    id: actor?.id || ctx?.id || '',
    name: actor?.name || (actor && typeof actor === 'string' ? actor : '') || ctx?.name || fallbackName || 'system',
    role: actor?.role || ctx?.role || ''
  }
}

// 追加一条审计记录：seq 连续、prev_hash 串联前一条；调用方必须已在事务中
export function appendCrisisEntry({
  incidentId, category, action, title, detail = {}, actor = null,
  refType = 'manual', refId = 0, occurredAt = ''
}) {
  const inc = db.prepare('SELECT id, status FROM crisis_incidents WHERE id=?').get(num(incidentId))
  if (!inc) throw new Error(`crisis incident #${incidentId} not found`)
  const a = actorOf(actor)
  const row = db.prepare('SELECT seq, entry_hash FROM crisis_audit_entries WHERE incident_id=? ORDER BY seq DESC LIMIT 1')
    .get(inc.id)
  const seq = num(row?.seq, 0) + 1
  const prev = row?.entry_hash || ''
  const stamp = occurredAt || ts()
  const header = {
    incident_id: num(inc.id), seq, category, action,
    actor_id: a.id, actor_role: a.role, ref_type: refType, ref_id: num(refId), occurred_at: stamp
  }
  const entryHash = hashOf(prev, header, detail)
  db.prepare(`INSERT INTO crisis_audit_entries
    (incident_id,seq,category,action,title,detail,actor_id,actor_name,actor_role,ref_type,ref_id,occurred_at,entry_hash,prev_hash)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(inc.id, seq, category, action, title, canonical(detail),
      a.id, a.name, a.role, refType, num(refId), stamp, entryHash, prev)
  db.prepare('UPDATE crisis_incidents SET updated_at=? WHERE id=?').run(stamp, inc.id)
  return { id: Number(db.prepare('SELECT last_insert_rowid() id').get().id), seq, entry_hash: entryHash }
}

// 归集到该应聘关联的所有「未结案」事件；结案后的事件链保持封存，不再追加
function openIncidentsOfApp(appId) {
  return db.prepare("SELECT * FROM crisis_incidents WHERE application_id=? AND status!='closed' ORDER BY id")
    .all(num(appId))
}

// 业务动作 → 事件审计链的统一归集钩子（关键操作/授权变更/状态回退三类）
// 返回写入的条目数；同一事件内不去重（每个业务动作都是独立事实）
export function mirrorAppEvent(appId, payload) {
  const incidents = openIncidentsOfApp(appId)
  if (!incidents.length) return 0
  incidents.forEach(inc => {
    appendCrisisEntry({
      incidentId: inc.id,
      category: payload.category,
      action: payload.action,
      title: payload.title,
      detail: { incident_code: inc.code, ...payload.detail },
      actor: payload.actor,
      refType: payload.refType,
      refId: payload.refId
    })
    // 状态回退类动作跨角色通知当前处置责任人，责任信息（事件号/责任人）随通知回写
    if (payload.category === 'rollback' && inc.owner_role) {
      db.prepare(`INSERT INTO notifications(recipient_role,type,title,body,task_id,application_id,crisis_incident_id,crisis_code,is_read,created_at)
                  VALUES(?,?,?,?,?,?,?,?,0,?)`)
        .run(inc.owner_role, 'crisis_rollback',
          `[${inc.code}] 危机处置中发生状态回退`,
          `${payload.title}；处置责任人 ${inc.owner_name}（${inc.owner_role}）请跟进确认`,
          0, num(appId), inc.id, inc.code, ts())
    }
  })
  return incidents.length
}

// ---- 事件编号：CRS-YYYYMMDD-NNN（按天递增）----
function nextCode(stamp = now()) {
  const day = stamp.slice(0, 10).replace(/-/g, '')
  const prefix = `CRS-${day}-`
  const last = db.prepare("SELECT code FROM crisis_incidents WHERE code LIKE ? ORDER BY id DESC LIMIT 1")
    .get(prefix + '%')?.code || ''
  const n = last.startsWith(prefix) ? num(last.slice(prefix.length), 0) + 1 : 1
  return prefix + String(n).padStart(3, '0')
}

export function createIncident({ title, severity = 'P2', applicationId = 0, owner = null, creator, note = '' }) {
  const stamp = ts()
  const code = nextCode()
  const ownerActor = owner || creator
  const r = db.prepare(`INSERT INTO crisis_incidents
    (code,title,severity,status,application_id,opened_by,opened_by_name,opened_role,opened_at,owner_id,owner_name,owner_role,updated_at)
    VALUES(?,?,?, 'open', ?,?,?,?,?,?,?,?,?)`)
    .run(code, title, severity, num(applicationId),
      creator.id, creator.name, creator.role, stamp,
      ownerActor.id, ownerActor.name, ownerActor.role, stamp)
  const id = Number(r.lastInsertRowid)
  appendCrisisEntry({
    incidentId: id, category: 'key_op', action: 'incident_open', title: `开立危机事件 ${code}`,
    detail: { code, severity, application_id: num(applicationId), note, owner: { id: ownerActor.id, name: ownerActor.name, role: ownerActor.role } },
    actor: creator
  })
  // 跨角色通知：责任人与开立人不同角色时，向责任角色投递
  if (ownerActor.role && ownerActor.role !== creator.role) {
    db.prepare(`INSERT INTO notifications(recipient_role,type,title,body,task_id,application_id,crisis_incident_id,crisis_code,is_read,created_at)
                VALUES(?,?,?,?,?,?,?,?,0,?)`)
      .run(ownerActor.role, 'crisis_opened', `[${code}] 新的危机处置事件待跟进`,
        `${creator.name} 开立「${title}」，处置责任人：${ownerActor.name}（${ownerActor.role}）`,
        0, num(applicationId), id, code, stamp)
  }
  return { id, code }
}

// 授权变更：更换处置责任人（仅招聘负责人指挥角色或当前责任人可操作）
export function changeOwner(incident, newOwner, { actor, reason }) {
  const stamp = ts()
  const from = { id: incident.owner_id, name: incident.owner_name, role: incident.owner_role }
  db.prepare('UPDATE crisis_incidents SET owner_id=?, owner_name=?, owner_role=?, updated_at=? WHERE id=?')
    .run(newOwner.id, newOwner.name, newOwner.role, stamp, incident.id)
  appendCrisisEntry({
    incidentId: incident.id, category: 'authz_change', action: 'owner_change',
    title: `处置责任人变更：${from.name || '空'} → ${newOwner.name}`,
    detail: { from, to: { id: newOwner.id, name: newOwner.name, role: newOwner.role }, reason },
    actor
  })
  db.prepare(`INSERT INTO notifications(recipient_role,type,title,body,task_id,application_id,crisis_incident_id,crisis_code,is_read,created_at)
              VALUES(?,?,?,?,?,?,?,?,0,?)`)
    .run(newOwner.role, 'crisis_owner', `[${incident.code}] 您被指定为危机处置责任人`,
      `${actor.name} 将「${incident.title}」的处置责任移交给您（原责任人：${from.name || '无'}）。原因：${reason || '未填写'}`,
      0, num(incident.application_id), incident.id, incident.code, stamp)
}

const NEXT_STATUS = { investigate: 'investigating', contain: 'contained', close: 'closed' }

// 事件处置动作：investigate 开始处置 / contain 控制 / close 结案（生成复盘） / note 过程记录
export function applyIncidentAction(incident, action, { actor, note = '', postmortemExtra = {} }) {
  const stamp = ts()
  if (action === 'note') {
    if (incident.status === 'closed') throw Object.assign(new Error('已结案事件请先回退再补充记录'), { status: 409 })
    return appendCrisisEntry({
      incidentId: incident.id, category: 'key_op', action: 'note',
      title: `处置记录：${note.slice(0, 40) || '（无内容）'}`,
      detail: { note, status: incident.status }, actor
    })
  }
  const target = NEXT_STATUS[action]
  if (!target) throw Object.assign(new Error('未知处置动作'), { status: 400 })
  if (incident.status === 'closed') throw Object.assign(new Error('事件已结案，请先回退到「已控制」'), { status: 409 })
  if (action === 'investigate' && incident.status !== 'open') throw Object.assign(new Error('仅待处置事件可以开始处置'), { status: 409 })
  if (action === 'contain' && !['open', 'investigating'].includes(incident.status)) {
    throw Object.assign(new Error('当前状态不能标记为已控制'), { status: 409 })
  }
  if (!String(note).trim()) throw Object.assign(new Error('处置动作必须填写说明，便于审计追责'), { status: 400 })

  db.prepare('UPDATE crisis_incidents SET status=?, updated_at=? WHERE id=?').run(target, stamp, incident.id)
  const entry = appendCrisisEntry({
    incidentId: incident.id,
    category: action === 'close' ? 'key_op' : 'key_op',
    action: action === 'investigate' ? 'incident_investigate' : action === 'contain' ? 'incident_contain' : 'incident_close',
    title: { investigate: '开始处置', contain: '事件已控制', close: '事件结案' }[action],
    detail: { from_status: incident.status, to_status: target, note, ...postmortemExtra },
    actor
  })
  incident.status = target

  if (action === 'close') {
    // 先落结案时间，再生成复盘报告（责任信息从审计链回写：授权变更、状态回退逐人归责）
    db.prepare('UPDATE crisis_incidents SET closed_at=?, ticket_status=CASE WHEN ticket_no<>"" THEN "resolved" ELSE ticket_status END WHERE id=?')
      .run(stamp, incident.id)
    const report = buildPostmortem(incident.id)
    db.prepare('UPDATE crisis_incidents SET postmortem=? WHERE id=?')
      .run(canonical(report), incident.id)
    notifyRoles(incident, 'crisis_closed', `[${incident.code}] 危机事件已结案`,
      `${actor.name} 完成「${incident.title}」复盘结案，工单 ${incident.ticket_no || '无'} 已同步关闭`)
  } else if (action === 'contain') {
    notifyRoles(incident, 'crisis_update', `[${incident.code}] 危机事件已控制`,
      `${actor.name} 标记「${incident.title}」已控制：${note}`)
  }
  return entry
}

// 结案回退：已结案事件整体回退到「已控制」，复盘报告保留，回退本身作为状态回退条目入链
export function rollbackIncident(incident, { actor, reason }) {
  if (incident.status !== 'closed') throw Object.assign(new Error('仅已结案事件可以回退'), { status: 409 })
  if (!String(reason).trim()) throw Object.assign(new Error('结案回退必须填写原因'), { status: 400 })
  const stamp = ts()
  db.prepare('UPDATE crisis_incidents SET status=?, closed_at=?, ticket_status=CASE WHEN ticket_no<>"" THEN "processing" ELSE ticket_status END, updated_at=? WHERE id=?')
    .run('contained', '', stamp, incident.id)
  appendCrisisEntry({
    incidentId: incident.id, category: 'rollback', action: 'incident_rollback',
    title: '结案回退：已结案 → 已控制',
    detail: { from_status: 'closed', to_status: 'contained', reason },
    actor
  })
  notifyRoles(incident, 'crisis_rollback', `[${incident.code}] 结案被回退`,
    `${actor.name} 回退了结案结论：${reason}；工单重新进入处理中`)
}

// 工单回写：创建/更新/解决关联工单，工单号与责任信息写回事件并通知
export function upsertTicket(incident, { ticketNo, action = 'create', note = '', actor }) {
  const stamp = ts()
  const fromNo = incident.ticket_no
  if (action === 'create') {
    if (!ticketNo) throw Object.assign(new Error('请填写工单号'), { status: 400 })
    db.prepare('UPDATE crisis_incidents SET ticket_no=?, ticket_status=?, updated_at=? WHERE id=?')
      .run(ticketNo, 'processing', stamp, incident.id)
    incident.ticket_no = ticketNo
    incident.ticket_status = 'processing'
  } else if (action === 'resolve') {
    if (!incident.ticket_no) throw Object.assign(new Error('该事件尚未关联工单'), { status: 409 })
    db.prepare('UPDATE crisis_incidents SET ticket_status=?, updated_at=? WHERE id=?')
      .run('resolved', stamp, incident.id)
    incident.ticket_status = 'resolved'
  }
  appendCrisisEntry({
    incidentId: incident.id, category: 'key_op',
    action: action === 'create' ? 'ticket_create' : 'ticket_resolve',
    title: action === 'create' ? `关联工单 ${ticketNo}` : `工单 ${incident.ticket_no} 已解决`,
    detail: { action, ticket_no: action === 'create' ? ticketNo : incident.ticket_no, from_ticket_no: fromNo, note },
    actor
  })
  notifyRoles(incident, 'crisis_ticket',
    `[${incident.code}] ${action === 'create' ? '已关联工单' : '工单已解决'}`,
    `${actor.name} ${action === 'create' ? `将工单 ${ticketNo} 纳入「${incident.title}」` : `解决了工单 ${incident.ticket_no}`}，责任人：${incident.owner_name}`)
}

function notifyRoles(incident, type, title, body) {
  const roles = [...new Set([incident.owner_role, incident.opened_role].filter(Boolean))]
  roles.forEach(role => db.prepare(`INSERT INTO notifications
    (recipient_role,type,title,body,task_id,application_id,crisis_incident_id,crisis_code,is_read,created_at)
    VALUES(?,?,?,?,?,?,?,?,0,?)`)
    .run(role, type, title, body, 0, num(incident.application_id), incident.id, incident.code, ts()))
}

// 复盘报告：从审计链回写责任信息——按人归集授权变更/关键操作/状态回退，形成可追责结论
function buildPostmortem(incidentId) {
  const inc = db.prepare('SELECT * FROM crisis_incidents WHERE id=?').get(incidentId)
  const entries = db.prepare('SELECT * FROM crisis_audit_entries WHERE incident_id=? ORDER BY seq').all(incidentId)
  const person = new Map()
  const ensure = (id, name, role) => {
    const key = id || name
    if (!person.has(key)) person.set(key, { id, name, role, key_ops: 0, authz: [], rollbacks: [] })
    return person.get(key)
  }
  entries.forEach(e => {
    const p = ensure(e.actor_id, e.actor_name, e.actor_role)
    if (e.category === 'key_op') p.key_ops++
    if (e.category === 'authz_change') p.authz.push({ seq: e.seq, title: e.title, at: e.occurred_at })
    if (e.category === 'rollback') p.rollbacks.push({ seq: e.seq, title: e.title, at: e.occurred_at, detail: parseDetail(e.detail) })
  })
  return {
    code: inc.code,
    title: inc.title,
    severity: inc.severity,
    application_id: num(inc.application_id),
    ticket_no: inc.ticket_no,
    opened_at: inc.opened_at,
    closed_at: inc.closed_at || ts(),
    owner: { id: inc.owner_id, name: inc.owner_name, role: inc.owner_role },
    stats: {
      total: entries.length,
      key_op: entries.filter(e => e.category === 'key_op').length,
      authz_change: entries.filter(e => e.category === 'authz_change').length,
      rollback: entries.filter(e => e.category === 'rollback').length
    },
    responsibilities: [...person.values()],
    chain_head: entries[entries.length - 1]?.entry_hash || '',
    generated_at: now()
  }
}

function parseDetail(s) { try { return JSON.parse(s || '{}') } catch { return {} } }

// 链校验：逐条重算 SHA-256，校验前向指针；任一不符即定位断裂位置
export function verifyChain(incidentId) {
  const rows = db.prepare('SELECT * FROM crisis_audit_entries WHERE incident_id=? ORDER BY seq').all(num(incidentId))
  let prev = ''
  const result = []
  let brokenAt = 0
  rows.forEach(e => {
    const detail = parseDetail(e.detail)
    const header = {
      incident_id: num(e.incident_id), seq: e.seq, category: e.category, action: e.action,
      actor_id: e.actor_id, actor_role: e.actor_role, ref_type: e.ref_type, ref_id: num(e.ref_id),
      occurred_at: e.occurred_at
    }
    const expectHash = hashOf(prev, header, detail)
    const linkOk = e.prev_hash === prev
    const hashOk = e.entry_hash === expectHash
    if ((!linkOk || !hashOk) && !brokenAt) brokenAt = e.seq
    result.push({ seq: e.seq, id: e.id, hash_ok: hashOk, link_ok: linkOk, entry_hash: e.entry_hash })
    prev = e.entry_hash
  })
  // seq 连续性检查
  rows.forEach((e, i) => {
    if (e.seq !== i + 1 && !brokenAt) brokenAt = e.seq
  })
  return {
    ok: brokenAt === 0 && rows.length > 0,
    entries: result,
    broken_at: brokenAt,
    head_hash: rows[rows.length - 1]?.entry_hash || '',
    verified_at: ts()
  }
}
