<script setup lang="ts">
import { computed, ref } from 'vue'
import { useLinkageStore } from '../stores/linkage'
import { useTagoutStore, type FeedbackKind, type LockoutTag, type TagBatch } from '../stores/tagout'

const store = useLinkageStore()
const tagout = useTagoutStore()

// ---- 提交挂牌 ----
const applicant = ref('调试员 甲')
const reason = ref('夜间检修挂牌，检修期间禁止动作')
const selectedDeviceIds = ref<string[]>([])
const forceFailure = ref(false)
const submitMsg = ref('')

const deviceItems = computed(() => store.devices.map((device) => ({ title: `${device.name}（${device.id}）`, value: device.id })))
const untaggedDeviceIds = computed(() => store.devices.filter((device) => !tagout.hangingTags.some((tag) => tag.deviceIds.includes(device.id))).map((device) => device.id))

function submitTag() {
  if (selectedDeviceIds.value.length === 0) return
  const batch = tagout.submitBatch({ applicant: applicant.value, reason: reason.value, deviceIds: selectedDeviceIds.value, forceFailure: forceFailure.value })
  submitMsg.value = `${batch.id}：${batch.status}`
  selectedDeviceIds.value = []
}

function submitConcurrent() {
  if (selectedDeviceIds.value.length === 0) return
  const { a, b } = tagout.submitConcurrent({ applicantA: '调试员 甲', applicantB: '调试员 乙', reason: reason.value, deviceIds: selectedDeviceIds.value })
  submitMsg.value = `模拟同时提交：${a.id} 先到生效；${b.id} 后到${b.status === '已驳回' ? '驳回' : '生效'}`
  selectedDeviceIds.value = []
}

// ---- 挂牌签认与覆盖 ----
const signPriority = ref<Record<string, 1 | 2 | 3>>({})
function priorityOf(tag: LockoutTag): 1 | 2 | 3 {
  return signPriority.value[tag.id] ?? 1
}

const coverageDialog = ref(false)
const coverageTag = ref<LockoutTag | null>(null)
const coverageDraft = ref<string[]>([])
function openCoverage(tag: LockoutTag) {
  coverageTag.value = tag
  coverageDraft.value = [...tag.deviceIds]
  coverageDialog.value = true
}
function saveCoverage() {
  if (coverageTag.value) tagout.updateTagCoverage(coverageTag.value.id, coverageDraft.value)
  coverageDialog.value = false
}

function deviceName(id: string) {
  return store.devices.find((device) => device.id === id)?.name ?? id
}

// ---- 批次 ----
function batchStatusColor(status: TagBatch['status']) {
  if (status === '已生效' || status === '已完成续作') return 'success'
  if (status === '已驳回') return 'error'
  return 'warning'
}

// ---- 回传 ----
const fbDeviceId = ref('')
const fbKind = ref<FeedbackKind>('报警回传')
const fbMessage = ref('')
function receive() {
  if (!fbDeviceId.value) return
  const kindMessage: Record<FeedbackKind, string> = {
    报警回传: `${deviceName(fbDeviceId.value)} 报警已回传`,
    动作反馈: `${deviceName(fbDeviceId.value)} 动作反馈已到`,
    复电: `${deviceName(fbDeviceId.value)} 复电已送达`,
  }
  tagout.receiveFeedback({ deviceId: fbDeviceId.value, kind: fbKind.value, message: fbMessage.value || kindMessage[fbKind.value] })
  fbMessage.value = ''
}

function fmtTime(ts: number) {
  return new Date(ts).toTimeString().slice(0, 8)
}
</script>

<template>
  <section class="page">
    <div class="page-head">
      <div><p class="eyebrow">LOCKOUT & FEEDBACK / 挂牌回传</p><h1>检修挂牌、审阅批次与现场回传</h1><p class="muted">挂牌、因果规则与审阅批次共用依据：覆盖范围一改，依赖它的规则立即失效重算；先到批次生效，后到保留冲突依据；写入失败按批次号续作；回传确认单向不可逆。</p></div>
    </div>

    <div class="panel submit-panel">
      <div class="panel-head"><h3>提交挂牌批次</h3><span class="muted">同一台设备先到批次生效</span></div>
      <v-row dense>
        <v-col cols="12" md="3"><v-text-field v-model="applicant" label="申请人" density="compact" hide-details /></v-col>
        <v-col cols="12" md="4"><v-text-field v-model="reason" label="挂牌说明" density="compact" hide-details /></v-col>
        <v-col cols="12" md="5">
          <v-select v-model="selectedDeviceIds" :items="deviceItems" label="覆盖设备（可多选）" density="compact" hide-details multiple chips />
        </v-col>
      </v-row>
      <div class="submit-row">
        <v-checkbox v-model="forceFailure" label="模拟写入失败（演练按批次号续作）" density="compact" hide-details color="warning" />
        <v-spacer />
        <v-btn variant="tonal" color="secondary" prepend-icon="mdi-account-multiple-outline" @click="submitConcurrent">模拟双人同时提交</v-btn>
        <v-btn color="primary" prepend-icon="mdi-lock-outline" @click="submitTag">提交挂牌</v-btn>
      </div>
      <v-alert v-if="submitMsg" type="info" variant="tonal" density="compact" class="mt-3">{{ submitMsg }}</v-alert>
    </div>

    <div class="panel">
      <div class="panel-head"><h3>检修挂牌</h3><v-chip size="small" variant="tonal">挂牌中 {{ tagout.hangingTags.length }} · 已闭锁 {{ tagout.blockedRuleIds.length }} 条规则</v-chip></div>
      <v-table hover>
        <thead><tr><th>挂牌号</th><th>批次号</th><th>覆盖设备</th><th>说明</th><th>申请人</th><th>状态</th><th>已签优先级</th><th>操作</th></tr></thead>
        <tbody>
          <tr v-for="tag in tagout.tags" :key="tag.id">
            <td class="mono">{{ tag.id }}</td>
            <td class="mono">{{ tag.batchId }}</td>
            <td><v-chip v-for="id in tag.deviceIds" :key="id" size="x-small" class="mr-1">{{ deviceName(id) }}</v-chip></td>
            <td class="reason">{{ tag.reason }}</td>
            <td>{{ tag.applicant }}</td>
            <td>
              <v-chip v-if="tag.status === '已签'" size="small" color="success" variant="tonal">已签 · 闭锁中</v-chip>
              <v-chip v-else-if="tag.status === '待签'" size="small" color="warning" variant="tonal">待签</v-chip>
              <v-chip v-else size="small" variant="tonal">已撤销</v-chip>
            </td>
            <td>
              <v-select v-if="tag.status === '待签'" v-model="signPriority[tag.id]" :items="[1,2,3]" density="compact" hide-details style="max-width:90px" label="优先级" />
              <span v-else-if="tag.signedPriority" class="muted">P{{ tag.signedPriority }} 疏散继续</span>
              <span v-else class="muted">—</span>
            </td>
            <td>
              <v-btn v-if="tag.status === '待签'" size="small" color="success" variant="tonal" @click="tagout.signTag(tag.id, priorityOf(tag))">签认</v-btn>
              <v-btn v-if="tag.status !== '已撤销'" size="small" variant="text" @click="openCoverage(tag)">调整覆盖</v-btn>
              <v-btn v-if="tag.status !== '已撤销'" size="small" color="warning" variant="text" @click="tagout.revokeTag(tag.id)">摘牌</v-btn>
            </td>
          </tr>
          <tr v-if="tagout.tags.length === 0"><td colspan="8" class="empty">暂无挂牌</td></tr>
        </tbody>
      </v-table>
    </div>

    <div class="panel">
      <div class="panel-head"><h3>审阅批次</h3><span class="muted">驳回保留说明与冲突依据；部分写入按批次号续作</span></div>
      <v-table hover>
        <thead><tr><th>批次号</th><th>申请人</th><th>说明</th><th>状态</th><th>写入进度</th><th>冲突依据</th><th>操作</th></tr></thead>
        <tbody>
          <tr v-for="batch in tagout.batches" :key="batch.id">
            <td class="mono">{{ batch.id }}</td>
            <td>{{ batch.applicant }}</td>
            <td class="reason">{{ batch.reason }}</td>
            <td><v-chip size="small" :color="batchStatusColor(batch.status)" variant="tonal">{{ batch.status }}</v-chip></td>
            <td>{{ batch.itemsApplied }}/{{ batch.itemsTotal }}<span v-if="batch.failedAttempts" class="muted"> · 失败 {{ batch.failedAttempts }} 次</span></td>
            <td class="conflict">
              <template v-if="batch.conflictBatchId">
                <v-icon icon="mdi-alert-outline" size="small" color="error" />
                <strong>{{ batch.conflictBatchId }}</strong>
                <div class="muted">{{ batch.conflictDetail }}</div>
              </template>
              <span v-else class="muted">—</span>
            </td>
            <td>
              <v-btn v-if="batch.status === '部分写入'" size="small" color="primary" variant="tonal" @click="tagout.resumeBatch(batch.id)">按批次号续作</v-btn>
              <span v-else class="muted">—</span>
            </td>
          </tr>
          <tr v-if="tagout.batches.length === 0"><td colspan="7" class="empty">暂无批次</td></tr>
        </tbody>
      </v-table>
    </div>

    <div class="panel">
      <div class="panel-head"><h3>报警回传与复电</h3><span class="muted">已确认结果单向不可逆，重复回传只计数</span></div>
      <v-row dense class="mb-3">
        <v-col cols="12" md="3"><v-select v-model="fbDeviceId" :items="deviceItems" label="设备" density="compact" hide-details /></v-col>
        <v-col cols="12" md="3"><v-select v-model="fbKind" :items="['报警回传','动作反馈','复电']" label="类型" density="compact" hide-details /></v-col>
        <v-col cols="12" md="4"><v-text-field v-model="fbMessage" label="回传内容（可留空）" density="compact" hide-details /></v-col>
        <v-col cols="12" md="2"><v-btn color="primary" variant="tonal" prepend-icon="mdi-bell-outline" @click="receive">接收回传</v-btn></v-col>
      </v-row>
      <v-table hover>
        <thead><tr><th>回传编号</th><th>批次号</th><th>类型</th><th>设备</th><th>内容</th><th>状态</th><th>重复回传</th><th>时间</th><th>操作</th></tr></thead>
        <tbody>
          <tr v-for="fb in tagout.feedbacks" :key="fb.id">
            <td class="mono">{{ fb.id }}</td>
            <td class="mono">{{ fb.batchId }}</td>
            <td><v-chip size="small" variant="outlined">{{ fb.kind }}</v-chip></td>
            <td>{{ deviceName(fb.deviceId) }}</td>
            <td class="reason">{{ fb.message }}</td>
            <td>
              <v-chip v-if="fb.state === '已确认'" size="small" color="success" variant="tonal" prepend-icon="mdi-check-circle">已确认</v-chip>
              <v-chip v-else size="small" color="warning" variant="tonal">待确认</v-chip>
            </td>
            <td>{{ fb.duplicateCount }} 次</td>
            <td class="muted">{{ fmtTime(fb.receivedAt) }}</td>
            <td>
              <v-btn v-if="fb.state === '待确认'" size="small" color="success" variant="tonal" @click="tagout.confirmFeedback(fb.id)">确认</v-btn>
              <v-btn size="small" variant="text" @click="tagout.receiveFeedback({ deviceId: fb.deviceId, ruleId: fb.ruleId, kind: fb.kind, message: fb.message })">重复回传</v-btn>
            </td>
          </tr>
          <tr v-if="tagout.feedbacks.length === 0"><td colspan="9" class="empty">暂无回传</td></tr>
        </tbody>
      </v-table>
    </div>

    <v-dialog v-model="coverageDialog" max-width="560">
      <v-card>
        <v-card-title>调整挂牌覆盖范围</v-card-title>
        <v-card-text>
          <p class="muted mb-3">覆盖范围一改，依赖它的规则立即失效重算。</p>
          <v-select v-model="coverageDraft" :items="deviceItems" label="覆盖设备" density="compact" hide-details multiple chips />
        </v-card-text>
        <v-card-actions><v-spacer /><v-btn @click="coverageDialog = false">取消</v-btn><v-btn color="primary" @click="saveCoverage">保存并重算</v-btn></v-card-actions>
      </v-card>
    </v-dialog>
  </section>
</template>

<style scoped>
.submit-panel { margin-bottom: 14px; }
.submit-row { display: flex; align-items: center; gap: 10px; margin-top: 12px; }
.panel { margin-bottom: 14px; padding: 14px 16px; }
.panel-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; }
.panel-head h3 { margin: 0; font-size: 15px; }
.mono { color: #267078; font-family: ui-monospace, monospace; font-weight: 700; font-size: 12px; }
.reason { max-width: 260px; font-size: 12px; color: #59676d; }
.conflict { max-width: 320px; font-size: 12px; color: #b13d2c; }
.conflict .muted { color: #7f8b90; margin-top: 2px; }
.empty { text-align: center; color: #9aa6ab; padding: 24px 0; }
.muted { color: #849096; font-size: 12px; }
</style>
