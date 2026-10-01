<script setup>
import { computed, ref } from 'vue'
import { useHrStore } from '@/store/hr'

const store = useHrStore()
const tab = ref('incidents')

// 弹窗状态
const showCreate = ref(false)
const ownerTarget = ref(null)
const ticketTarget = ref(null)
const actionTarget = ref(null)
const expanded = ref({})       // incidentId -> 是否展开审计链
const verification = ref({})    // incidentId -> 校验结果

const fTitle = ref(''); const fSeverity = ref('P2'); const fAppId = ref(0); const fOwnerId = ref(''); const fNote = ref('')
const ownerReason = ref(''); const ticketNo = ref('')
const actionNote = ref('')

const ROLE_LABEL = { recruiter: '招聘负责人', interviewer: '面试官', hiring_manager: '用人经理' }
const SEV_COLOR = { P1: 'var(--red)', P2: 'var(--accent2)', P3: 'var(--green)' }
const STATUS_META = {
  open: ['🔴', '待处置', 'var(--red)'],
  investigating: ['🟡', '处置中', 'var(--accent2)'],
  contained: ['🟢', '已控制', 'var(--green)'],
  closed: ['⚪', '已结案', 'var(--muted)']
}
const CATEGORY = {
  key_op: ['🔑', '关键操作', 'var(--accent)'],
  authz_change: ['🛡️', '授权变更', '#b58cff'],
  rollback: ['⏪', '状态回退', 'var(--red)']
}
// 动作码 → 可读标签
const ACTION_LABEL = {
  incident_open: '开立事件', incident_investigate: '开始处置', incident_contain: '标记控制',
  incident_close: '结案', incident_rollback: '结案回退', note: '处置记录',
  owner_change: '责任人变更', ticket_create: '关联工单', ticket_resolve: '工单解决',
  stage_advance: '阶段推进', stage_reject: '淘汰', stage_rollback: '阶段回退',
  offer_create: '发起 Offer', offer_update_salary: '调薪', offer_update_due: '改期',
  offer_accept: 'Offer 接受', offer_reject: 'Offer 拒绝', offer_join: '确认入职',
  offer_withdraw: 'Offer 撤回', offer_reopen: '重新发起',
  approval_submit: '审批提交', approval_approve: '审批通过', approval_return: '审批退回',
  approval_resubmit: '修改重提', approval_cancel: '审批撤销', approval_failed: '执行失败'
}

const ledgerFilter = ref({ category: '', q: '' })

const myOpen = computed(() => store.crisisIncidents.filter(i => i.status !== 'closed' && i.owner_id === store.userId))
const incidents = computed(() => store.crisisIncidents)

const ledger = computed(() => {
  let rows = store.crisisEntries.slice().reverse()
  if (ledgerFilter.value.category) rows = rows.filter(e => e.category === ledgerFilter.value.category)
  const kw = ledgerFilter.value.q.trim().toLowerCase()
  if (kw) {
    rows = rows.filter(e => {
      const inc = store.crisisIncidents.find(i => i.id === e.incident_id)
      return [e.title, e.actor_name, e.action, inc?.code, inc?.title].some(v => String(v || '').toLowerCase().includes(kw))
    })
  }
  return rows.slice(0, 300)
})

function incOf(id) { return store.crisisIncidents.find(i => i.id === id) }
const isRecruiter = computed(() => store.myRole === 'recruiter')
const canManage = inc => store.myRole === 'recruiter' || inc.owner_id === store.userId

function openCreate() {
  fTitle.value = ''; fSeverity.value = 'P2'; fAppId.value = 0
  fOwnerId.value = store.userId; fNote.value = ''
  showCreate.value = true
}
function confirmCreate() {
  if (!fTitle.value.trim()) { store.notify('error', '请填写危机事件标题'); return }
  store.createIncident({
    title: fTitle.value.trim(), severity: fSeverity.value,
    application_id: fAppId.value || 0, owner_id: fOwnerId.value || undefined, note: fNote.value
  }).then(r => { if (r?.ok) showCreate.value = false })
}
function openOwner(inc) { ownerTarget.value = inc; ownerReason.value = '' }
function confirmOwner() {
  store.changeIncidentOwner(ownerTarget.value.id, {
    owner_id: ownerTarget.value._ownerPick || store.userId, reason: ownerReason.value
  }).then(r => { if (r?.ok) ownerTarget.value = null })
}
function openTicket(inc) { ticketTarget.value = inc; ticketNo.value = inc.ticket_no || '' }
function confirmTicket(action) {
  store.linkTicket(ticketTarget.value.id, {
    action, ticket_no: ticketNo.value, note: ''
  }).then(r => { if (r?.ok) ticketTarget.value = null })
}
function askAction(inc, action) { actionTarget.value = { inc, action }; actionNote.value = '' }
function confirmAction() {
  const { inc, action } = actionTarget.value
  if (!actionNote.value.trim()) { store.notify('error', action === 'note' ? '请填写处置记录' : '处置动作必须填写说明，便于审计追责'); return }
  store.incidentAction(inc.id, action, actionNote.value).then(r => { if (r?.ok) actionTarget.value = null })
}
function onRollback(inc) {
  const reason = window.prompt('结案回退必须填写原因（回退记录将写入审计链）：')
  if (reason && reason.trim()) store.rollbackIncident(inc.id, reason.trim())
}
function toggleChain(id) {
  expanded.value = { ...expanded.value, [id]: !expanded.value[id] }
  if (!expanded.value[id]) { const v = { ...verification.value }; delete v[id]; verification.value = v }
}
async function onVerify(inc) {
  const r = await store.verifyIncident(inc.id)
  if (r?.ok) verification.value = { ...verification.value, [inc.id]: r.verification }
}
const fmt = t => t ? String(t).replace('T', ' ').slice(5, 16) : ''
const shortHash = h => h ? h.slice(0, 10) : ''
function detailPairs(e) {
  const skip = new Set(['incident_code'])
  return Object.entries(e.detail || {}).filter(([k]) => !skip.has(k)).map(([k, v]) => {
    let val = v
    if (k === 'from_stage' || k === 'to_stage') {
      val = { submitted: '投递', screening: '筛选', interview: '面试', offer: 'Offer', hired: '录用', rejected: '淘汰' }[v] || v
    }
    if (v && typeof v === 'object') val = JSON.stringify(v)
    return { k, v: String(val ?? '') }
  })
}
const DETAIL_LABEL = {
  application_id: '应聘', candidate_id: '候选人', position_id: '职位', from_stage: '原阶段', to_stage: '阶段',
  event_type: '事件类型', match_score: '当时评分', strategy_id: '策略版本', operator: '操作人',
  offer_id: 'Offer', change_type: '变更类型', from_status: '原状态', to_status: '新状态',
  from_salary: '原薪资', to_salary: '新薪资', note: '说明', task_id: '审批任务', task_type: '审批类型',
  step_no: '审批节点', role: '角色', action: '动作', reason: '原因', code: '事件号', severity: '等级',
  from: '原责任人', to: '新责任人', status: '状态', ticket_no: '工单号', from_ticket_no: '原工单',
  from_status_label: ''
}
</script>

<template>
  <div class="audit">
    <div class="role-banner card">
      <span v-if="isRecruiter">🧭 当前身份「招聘负责人」：可<b>开立危机事件</b>、<b>移交处置责任</b>（授权变更）并指挥处置；事件关联应聘后，后续关键操作/授权变更/状态回退将自动归集入链。</span>
      <span v-else>🛡️ 当前身份「{{ ROLE_LABEL[store.myRole] }}」：可查看全部危机审计链；被指定为<b>处置责任人</b>时可记录处置过程、标记控制、关联工单与结案复盘。</span>
    </div>

    <div class="stat-row">
      <div class="card stat" :class="{ on: tab === 'incidents' }" @click="tab = 'incidents'">
        <span>🚨</span><b>{{ store.crisisIncidents.filter(i => i.status !== 'closed').length }}</b><em>处置中事件</em>
      </div>
      <div class="card stat" :class="{ on: tab === 'incidents' }" @click="tab = 'incidents'">
        <span>👤</span><b>{{ myOpen.length }}</b><em>我负责的</em>
      </div>
      <div class="card stat" :class="{ on: tab === 'ledger' }" @click="tab = 'ledger'">
        <span>🔗</span><b>{{ store.crisisEntries.length }}</b><em>审计链条目</em>
      </div>
      <div class="card stat" :class="{ on: tab === 'ledger' }" @click="tab = 'ledger'">
        <span>⏪</span><b>{{ store.crisisEntries.filter(e => e.category === 'rollback').length }}</b><em>状态回退记录</em>
      </div>
    </div>

    <div class="tabs">
      <button :class="{ on: tab === 'incidents' }" @click="tab = 'incidents'">🚨 危机事件 <em class="cnt" v-if="myOpen.length">{{ myOpen.length }}</em></button>
      <button :class="{ on: tab === 'ledger' }" @click="tab = 'ledger'">🔗 跨角色审计台账</button>
      <button class="new-btn" @click="openCreate">＋ 开立危机事件</button>
    </div>

    <!-- ========== 事件列表 ========== -->
    <div class="ilist" v-if="tab === 'incidents'">
      <div class="icard card" v-for="inc in incidents" :key="inc.id">
        <div class="i-head">
          <span class="i-code">{{ inc.code }}</span>
          <span class="i-sev" :style="{ color: SEV_COLOR[inc.severity], borderColor: SEV_COLOR[inc.severity] }">{{ inc.severity_label }}</span>
          <span class="i-status" :style="{ color: STATUS_META[inc.status][2] }">{{ STATUS_META[inc.status][0] }} {{ inc.status_label }}</span>
          <em class="muted i-id">#{{ inc.id }}</em>
        </div>
        <div class="i-main">
          <b>{{ inc.title }}</b>
          <span class="muted" v-if="inc.application_id">👤 {{ inc.candidate }} · {{ inc.position }}</span>
        </div>
        <div class="i-resp">
          <span class="resp-chip">🛡️ 责任人 <b>{{ inc.owner_name }}</b>（{{ ROLE_LABEL[inc.owner_role] || inc.owner_role }}）</span>
          <span class="resp-chip" v-if="inc.ticket_no">🎫 工单 <b>{{ inc.ticket_no }}</b>
            <em :class="inc.ticket_status === 'resolved' ? 'ok' : 'warn'">{{ inc.ticket_status === 'resolved' ? '已解决' : '处理中' }}</em>
          </span>
          <span class="resp-chip">🔑 {{ inc.counts.key_op }} · 🛡️ {{ inc.counts.authz_change }} · ⏪ {{ inc.counts.rollback }}</span>
          <span class="muted i-time">开立 {{ fmt(inc.opened_at) }}</span>
        </div>

        <!-- 复盘报告：结案时从审计链回写责任信息 -->
        <div class="postmortem" v-if="inc.postmortem">
          <div class="pm-head">📋 复盘报告 · {{ inc.postmortem.code }}（{{ fmt(inc.postmortem.closed_at) }} 结案）</div>
          <div class="pm-stats">
            审计链 {{ inc.postmortem.stats.total }} 条：关键操作 {{ inc.postmortem.stats.key_op }} / 授权变更 {{ inc.postmortem.stats.authz_change }} / 状态回退 {{ inc.postmortem.stats.rollback }}
          </div>
          <div class="pm-owners">
            <div class="pm-person" v-for="(p, i) in inc.postmortem.responsibilities" :key="i">
              <b>{{ p.name }}</b><em class="muted">{{ ROLE_LABEL[p.role] || p.role }}</em>
              <span class="muted">关键操作 {{ p.key_ops }} 次<template v-if="p.authz.length"> · 授权变更 {{ p.authz.length }} 次</template><template v-if="p.rollbacks.length"> · <i class="rb">回退 {{ p.rollbacks.length }} 次</i></template></span>
            </div>
          </div>
          <div class="pm-hash muted">链头哈希 <code>{{ inc.postmortem.chain_head }}</code></div>
        </div>

        <div class="i-acts">
          <template v-if="inc.status !== 'closed' && canManage(inc)">
            <button class="primary" v-if="inc.status === 'open'" @click="askAction(inc, 'investigate')">▶️ 开始处置</button>
            <button class="succ" v-if="['open', 'investigating'].includes(inc.status)" @click="askAction(inc, 'contain')">✅ 标记控制</button>
            <button class="ghost" @click="askAction(inc, 'note')">📝 处置记录</button>
            <button class="succ" v-if="inc.status === 'contained'" @click="askAction(inc, 'close')">📋 结案并复盘</button>
          </template>
          <button class="warn" v-if="inc.status === 'closed' && canManage(inc)" @click="onRollback(inc)">⏪ 回退结案</button>
          <button class="ghost" v-if="inc.status !== 'closed' && isRecruiter" @click="openOwner(inc)">🛡️ 移交责任</button>
          <button class="ghost" v-if="inc.status !== 'closed' && canManage(inc) && !inc.ticket_no" @click="openTicket(inc)">🎫 关联工单</button>
          <button class="ghost" v-if="inc.ticket_no && inc.ticket_status !== 'resolved' && inc.status !== 'closed' && canManage(inc)" @click="openTicket(inc)">🎫 工单处理</button>
          <button class="ghost chain-toggle" @click="toggleChain(inc.id)">
            {{ expanded[inc.id] ? '▾ 收起' : '▸ 审计链' }}（{{ inc.entries.length }}）
          </button>
          <button class="ghost verify-btn" @click="onVerify(inc)">🔍 校验链完整性</button>
        </div>
        <div class="verify-result" v-if="verification[inc.id]">
          <span v-if="verification[inc.id].ok" class="ok">✅ 链完整：{{ verification[inc.id].entries.length }} 条记录哈希全部通过，前向指针连续</span>
          <span v-else class="bad">⚠️ 链在第 {{ verification[inc.id].broken_at }} 条断裂，审计记录可能被篡改！</span>
        </div>

        <!-- 不可篡改审计链时间线 -->
        <div class="chain-timeline" v-if="expanded[inc.id]">
          <div class="ct-item" v-for="e in inc.entries" :key="e.id">
            <span class="ct-cat" :style="{ color: CATEGORY[e.category][2] }">{{ CATEGORY[e.category][0] }}</span>
            <div class="ct-body">
              <div class="ct-line">
                <b>#{{ e.seq }} {{ e.title }}</b>
                <span class="ct-tag" :style="{ color: CATEGORY[e.category][2], borderColor: CATEGORY[e.category][2] }">{{ CATEGORY[e.category][1] }}</span>
                <em class="muted">{{ ACTION_LABEL[e.action] || e.action }}</em>
              </div>
              <div class="muted ct-meta">{{ e.actor_name }}（{{ ROLE_LABEL[e.actor_role] || e.actor_role }}） · {{ fmt(e.occurred_at) }} · {{ e.ref_type }}#{{ e.ref_id }}</div>
              <div class="ct-detail" v-if="detailPairs(e).length">
                <span class="dp" v-for="dp in detailPairs(e)" :key="dp.k">{{ DETAIL_LABEL[dp.k] || dp.k }}: {{ dp.v }}</span>
              </div>
              <code class="ct-hash muted" :title="e.entry_hash">sha256:{{ shortHash(e.entry_hash) }} ← {{ shortHash(e.prev_hash) || 'GENESIS' }}</code>
            </div>
          </div>
        </div>
      </div>
      <div class="card empty" v-if="!incidents.length">
        暂无危机事件。发生跨角色紧急处置（如误淘汰复活、Offer 异常撤回、临时授权变更）时，开立事件后全部关键动作将自动形成不可篡改审计链。
      </div>
    </div>

    <!-- ========== 跨角色审计台账 ========== -->
    <div class="ledger card" v-if="tab === 'ledger'">
      <div class="ledger-filter">
        <input v-model="ledgerFilter.q" placeholder="搜索事件号 / 标题 / 责任人 / 动作…" />
        <div class="seg">
          <button :class="{ on: !ledgerFilter.category }" @click="ledgerFilter.category = ''">全部</button>
          <button v-for="(m, k) in CATEGORY" :key="k" :class="{ on: ledgerFilter.category === k }" @click="ledgerFilter.category = k">{{ m[0] }} {{ m[1] }}</button>
        </div>
      </div>
      <table>
        <thead>
          <tr><th>#</th><th>事件</th><th>分类</th><th>动作</th><th>责任人</th><th>角色</th><th>时间</th><th>哈希</th></tr>
        </thead>
        <tbody>
          <tr v-for="e in ledger" :key="e.id">
            <td>{{ e.seq }}</td>
            <td><b>{{ incOf(e.incident_id)?.code }}</b><span class="muted"> {{ e.title }}</span></td>
            <td><span :style="{ color: CATEGORY[e.category][2] }">{{ CATEGORY[e.category][0] }} {{ CATEGORY[e.category][1] }}</span></td>
            <td class="muted">{{ ACTION_LABEL[e.action] || e.action }}</td>
            <td>{{ e.actor_name }}</td>
            <td class="muted">{{ ROLE_LABEL[e.actor_role] || e.actor_role }}</td>
            <td class="muted">{{ fmt(e.occurred_at) }}</td>
            <td><code :title="e.entry_hash">{{ shortHash(e.entry_hash) }}</code></td>
          </tr>
        </tbody>
      </table>
      <div class="empty" v-if="!ledger.length">暂无符合条件的审计记录。</div>
    </div>

    <!-- 开立事件 -->
    <div class="modal" v-if="showCreate" @click.self="showCreate = false">
      <div class="modal-box card">
        <h3>🚨 开立危机处置事件</h3>
        <label class="muted">事件标题</label>
        <input v-model="fTitle" placeholder="如：候选人被误淘汰需紧急复活并复核 Offer" />
        <label class="muted">严重等级</label>
        <div class="seg">
          <button v-for="s in ['P1','P2','P3']" :key="s" :class="{ on: fSeverity === s }" :style="fSeverity === s ? { borderColor: SEV_COLOR[s], color: SEV_COLOR[s] } : {}" @click="fSeverity = s">{{ s === 'P1' ? 'P1 重大' : s === 'P2' ? 'P2 高' : 'P3 中' }}</button>
        </div>
        <label class="muted">关联应聘（可选，选定后该应聘的后续关键操作/审批授权/回退自动归集入链）</label>
        <select v-model.number="fAppId">
          <option :value="0">不关联</option>
          <option v-for="a in store.applications" :key="a.id" :value="a.id">{{ a.candidate }} · {{ a.position }}（#{{ a.id }} {{ a.stage }}）</option>
        </select>
        <label class="muted">处置责任人</label>
        <select v-model="fOwnerId">
          <option v-for="u in store.users" :key="u.id" :value="u.id">{{ u.name }} · {{ u.title }}</option>
        </select>
        <label class="muted">情况说明</label>
        <textarea v-model="fNote" rows="3" placeholder="危机背景、已掌握的事实…"></textarea>
        <div class="acts">
          <button class="primary" @click="confirmCreate">开立并启动审计链</button>
          <button class="ghost" @click="showCreate = false">取消</button>
        </div>
      </div>
    </div>

    <!-- 移交责任（授权变更） -->
    <div class="modal" v-if="ownerTarget" @click.self="ownerTarget = null">
      <div class="modal-box card">
        <h3>🛡️ 移交处置责任 · {{ ownerTarget.code }}</h3>
        <p class="muted">当前责任人：<b>{{ ownerTarget.owner_name }}</b>（{{ ROLE_LABEL[ownerTarget.owner_role] || ownerTarget.owner_role }}）。授权变更将作为审计链中的「授权变更」条目，并通知新责任人。</p>
        <label class="muted">新责任人</label>
        <select v-model="ownerTarget._ownerPick">
          <option v-for="u in store.users.filter(u => u.id !== ownerTarget.owner_id)" :key="u.id" :value="u.id">{{ u.name }} · {{ u.title }}</option>
        </select>
        <label class="muted">移交原因（必填）</label>
        <textarea v-model="ownerReason" rows="3" placeholder="如：需要用人经理复核薪资授权"></textarea>
        <div class="acts">
          <button class="warn" :disabled="!ownerReason.trim()" @click="confirmOwner">确认移交</button>
          <button class="ghost" @click="ownerTarget = null">取消</button>
        </div>
      </div>
    </div>

    <!-- 工单 -->
    <div class="modal" v-if="ticketTarget" @click.self="ticketTarget = null">
      <div class="modal-box card">
        <h3>🎫 工单回写 · {{ ticketTarget.code }}</h3>
        <template v-if="!ticketTarget.ticket_no">
          <label class="muted">工单号</label>
          <input v-model="ticketNo" placeholder="如 ITSM-20261001-018" />
          <div class="acts">
            <button class="primary" :disabled="!ticketNo.trim()" @click="confirmTicket('create')">关联工单（处理中）</button>
            <button class="ghost" @click="ticketTarget = null">取消</button>
          </div>
        </template>
        <template v-else>
          <p class="muted">当前工单 <b>{{ ticketTarget.ticket_no }}</b>（{{ ticketTarget.ticket_status === 'resolved' ? '已解决' : '处理中' }}），责任人：{{ ticketTarget.owner_name }}</p>
          <div class="acts">
            <button class="succ" v-if="ticketTarget.ticket_status !== 'resolved'" @click="confirmTicket('resolve')">标记工单已解决</button>
            <button class="ghost" @click="ticketTarget = null">关闭</button>
          </div>
        </template>
      </div>
    </div>

    <!-- 处置动作 -->
    <div class="modal" v-if="actionTarget" @click.self="actionTarget = null">
      <div class="modal-box card">
        <h3>{{ { investigate: '▶️ 开始处置', contain: '✅ 标记事件已控制', close: '📋 结案并生成复盘报告', note: '📝 追加处置记录' }[actionTarget.action] }} · {{ actionTarget.inc.code }}</h3>
        <p class="muted" v-if="actionTarget.action === 'close'">结案时将依据审计链自动生成复盘报告，逐人回写关键操作、授权变更与状态回退责任；关联工单同步标记解决。</p>
        <label class="muted">{{ actionTarget.action === 'note' ? '处置记录' : '处置说明（必填，进入审计链）' }}</label>
        <textarea v-model="actionNote" rows="4" placeholder="采取的措施、结论或遗留风险…"></textarea>
        <div class="acts">
          <button :class="actionTarget.action === 'close' ? 'succ' : 'primary'" @click="confirmAction">确认</button>
          <button class="ghost" @click="actionTarget = null">取消</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.audit { display: flex; flex-direction: column; gap: 14px; }
.role-banner { padding: 10px 14px; font-size: 12.5px; color: var(--muted); background: rgba(181,140,255,.07); border-color: rgba(181,140,255,.3); }
.role-banner b { color: #b58cff; margin: 0 2px; }
.stat-row { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; }
.stat { display: flex; flex-direction: column; align-items: center; gap: 2px; padding: 14px; cursor: pointer; transition: .18s; }
.stat:hover { border-color: #b58cff; }
.stat.on { border-color: #b58cff; background: rgba(181,140,255,.08); }
.stat span { font-size: 20px; }
.stat b { font-size: 22px; }
.stat em { font-style: normal; font-size: 12px; color: var(--muted); }
.tabs { display: flex; gap: 8px; align-items: center; }
.tabs button { padding: 7px 14px; font-size: 13px; opacity: .85; }
.tabs button.on { opacity: 1; border-color: #b58cff; background: rgba(181,140,255,.15); color: #c9adff; }
.new-btn { margin-left: auto !important; opacity: 1 !important; }
.cnt { font-style: normal; font-size: 10px; background: var(--red); color: #fff; border-radius: 8px; padding: 1px 6px; margin-left: 4px; }
.ilist { display: flex; flex-direction: column; gap: 12px; }
.icard { display: flex; flex-direction: column; gap: 10px; padding: 14px 16px; }
.i-head { display: flex; align-items: center; gap: 10px; }
.i-code { font-weight: 700; font-size: 13.5px; color: #c9adff; font-family: ui-monospace, monospace; }
.i-sev { font-size: 11px; border: 1px solid; border-radius: 10px; padding: 2px 8px; }
.i-status { font-size: 12px; }
.i-id { margin-left: auto; font-style: normal; }
.i-main { display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap; font-size: 14.5px; }
.i-resp { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; font-size: 12px; }
.resp-chip { background: var(--panel2); border: 1px solid var(--border); border-radius: 12px; padding: 3px 10px; }
.resp-chip em { font-style: normal; margin-left: 4px; }
.resp-chip em.ok { color: var(--green); }
.resp-chip em.warn { color: var(--accent2); }
.i-time { margin-left: auto; font-size: 11.5px; }
.postmortem { background: rgba(87,214,160,.06); border: 1px solid rgba(87,214,160,.3); border-radius: 10px; padding: 10px 12px; display: flex; flex-direction: column; gap: 7px; }
.pm-head { font-weight: 700; font-size: 13px; color: var(--green); }
.pm-stats { font-size: 12px; color: var(--muted); }
.pm-owners { display: flex; flex-direction: column; gap: 5px; }
.pm-person { display: flex; gap: 10px; align-items: baseline; font-size: 12.5px; }
.pm-person em { font-style: normal; font-size: 11px; color: var(--muted); min-width: 70px; }
.pm-person .rb { color: var(--red); font-style: normal; }
.pm-hash { font-size: 11px; }
.pm-hash code, .ct-hash { word-break: break-all; }
.i-acts { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.i-acts button { font-size: 12px; padding: 5px 11px; }
.chain-toggle { margin-left: auto; }
.verify-btn { font-size: 11px !important; color: #c9adff; }
.verify-result { font-size: 12px; border-radius: 8px; padding: 6px 10px; }
.verify-result .ok { color: var(--green); }
.verify-result .bad { color: var(--red); }
.chain-timeline { border-top: 1px dashed var(--border); padding-top: 10px; display: flex; flex-direction: column; gap: 10px; }
.ct-item { display: flex; gap: 10px; }
.ct-cat { font-size: 15px; padding-top: 1px; }
.ct-body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; border-left: 2px solid var(--border); padding-left: 12px; }
.ct-line { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 12.5px; }
.ct-tag { font-size: 10px; border: 1px solid; border-radius: 9px; padding: 1px 7px; }
.ct-meta { font-size: 11px; }
.ct-detail { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 2px; }
.dp { font-size: 11px; background: var(--panel2); border: 1px solid var(--border); border-radius: 6px; padding: 1px 7px; color: var(--muted); }
.ct-hash { font-size: 10.5px; }
.ledger { padding: 14px 16px; }
.ledger-filter { display: flex; gap: 10px; margin-bottom: 12px; align-items: center; }
.ledger-filter input { flex: 1; max-width: 320px; }
.seg { display: flex; gap: 6px; }
.seg button { font-size: 12px; padding: 5px 11px; opacity: .8; }
.seg button.on { opacity: 1; border-color: var(--accent); }
table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
th { text-align: left; color: var(--muted); font-weight: 500; font-size: 11.5px; padding: 7px 8px; border-bottom: 1px solid var(--border); }
td { padding: 7px 8px; border-bottom: 1px solid rgba(255,255,255,.05); vertical-align: top; }
td code { font-size: 10.5px; color: var(--muted); }
.modal-box label { display: block; margin: 8px 0 4px; font-size: 12px; }
.modal-box input, .modal-box select, .modal-box textarea { width: 100%; }
.modal-box textarea { background: #101731; border: 1px solid var(--border); border-radius: 8px; color: var(--text); padding: 8px; font-size: 13px; font-family: inherit; resize: vertical; margin: 4px 0; }
.empty { padding: 30px; text-align: center; color: var(--muted); font-size: 13px; }
</style>
