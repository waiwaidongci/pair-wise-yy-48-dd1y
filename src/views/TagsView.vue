<script setup lang="ts">
import { computed, ref } from 'vue'
import { useLinkageStore } from '../stores/linkage'
import { scopeLabel, type CallbackEvent, type LockoutReason, type TagScopeLevel } from '../linkage/domain'
import { LOCKOUT_STEPS, armNextWriteFailure } from '../linkage/controller'

const store = useLinkageStore()

const scopeLevel = ref<TagScopeLevel>('device')
const target = ref('A-01-01')
const reason = ref<LockoutReason>('检修挂牌')
const note = ref('')
const operator = ref('调试员 A')
const failStep = ref<'none' | 'controller:lockout' | 'panel:lockout' | 'controller:release'>('none')
const busy = ref<string | null>(null)
const lastResult = ref('')

const scope = computed<{ level: TagScopeLevel; target: string }>(() => ({ level: scopeLevel.value, target: target.value }))

const zoneOptions = computed(() => [...new Set(store.devices.map((device) => device.zone))])
const floorOptions = computed(() => [...new Set(store.devices.map((device) => device.floor))])
const targetItems = computed(() => {
  if (scopeLevel.value === 'zone') return zoneOptions.value
  if (scopeLevel.value === 'floor') return floorOptions.value
  return store.devices.map((device) => ({ title: `${device.name}（${device.id}）`, value: device.id }))
})

function onScopeLevelChange() {
  if (scopeLevel.value === 'zone') target.value = zoneOptions.value[0]
  else if (scopeLevel.value === 'floor') target.value = floorOptions.value[0]
  else target.value = store.devices[0]?.id ?? ''
}

async function submitTag() {
  if (failStep.value !== 'none') armNextWriteFailure(failStep.value)
  busy.value = 'submit'
  try {
    const batch = await store.submitLockoutBatch({
      op: '挂牌',
      scope: scope.value,
      reason: reason.value,
      note: note.value || '夜班检修挂牌',
      operator: operator.value,
    })
    lastResult.value = batch.status === '已生效'
      ? `批次 ${batch.batchNo} 已生效，当前共用依据 ${store.basisId}`
      : `批次 ${batch.batchNo} 未生效：${batch.status}${batch.conflictDetail ? `（${batch.conflictDetail}）` : ''}`
  } finally {
    busy.value = null
    failStep.value = 'none'
  }
}

async function releaseTag(tagId: string) {
  if (failStep.value !== 'none') armNextWriteFailure(failStep.value)
  busy.value = tagId
  try {
    const batch = await store.submitReleaseBatch(tagId, { note: '复电后摘牌', operator: operator.value })
    lastResult.value = batch.status === '已撤销'
      ? `批次 ${batch.batchNo} 摘牌完成，依据推进至 ${store.basisId}`
      : `批次 ${batch.batchNo} ${batch.status}`
  } finally {
    busy.value = null
    failStep.value = 'none'
  }
}

async function resume(batchNo: string) {
  if (failStep.value !== 'none') armNextWriteFailure(failStep.value)
  busy.value = batchNo
  try {
    const batch = await store.resumeBatch(batchNo)
    lastResult.value = batch.status === '已生效'
      ? `批次 ${batch.batchNo} 按原批次号续作生效，当前依据 ${store.basisId}`
      : batch.status === '冲突未生效'
        ? `批次 ${batch.batchNo} 续作时仍与 ${batch.conflictWith} 冲突，说明已保留`
        : `批次 ${batch.batchNo} 续作${batch.status}`
  } finally {
    busy.value = null
    failStep.value = 'none'
  }
}

async function emitCallback(deviceId: string, event: CallbackEvent) {
  // 复电回传若挂在某个写入失败批次上，界面提示可按批次号续作
  const failed = event === '复电' ? store.failedBatches[0]?.batchNo : undefined
  const outcome = store.receiveCallback({ deviceId, event, batchNo: failed, note: event === '复电' ? '现场复电回传' : '夜班报警回传' })
  lastResult.value = outcome.duplicate
    ? `收到重复 ${event} 回传（${outcome.record.duplicates + 1} 次），状态保持「${outcome.record.status}」不回退`
    : `收到 ${event} 回传，状态「待确认」`
}

function statusColor(status: string) {
  return { 已生效: 'success', 已撤销: 'grey', 冲突未生效: 'error', 写入失败待续作: 'warning' }[status] ?? 'default'
}

const stepLabels = Object.fromEntries([...LOCKOUT_STEPS, { name: 'controller:release', label: '写入控制器恢复位' }].map((step) => [step.name, step.label]))
</script>

<template>
  <section class="page">
    <div class="page-head">
      <div>
        <p class="eyebrow">LOCKOUT & BATCH / 检修挂牌与审阅批次</p>
        <h1>挂牌、规则与批次共用同一份依据</h1>
        <p class="muted">挂牌覆盖范围一改，依据立即推进，依赖它的规则立即失效重算；疏散动作按已签优先级继续。并发同挂牌先到先得。</p>
      </div>
      <v-chip color="secondary" variant="tonal" prepend-icon="mdi-fingerprint" size="large">当前共用依据 {{ store.basisId }}</v-chip>
    </div>

    <v-alert v-if="lastResult" type="info" variant="tonal" density="compact" class="mb-3" closable @click="lastResult = ''">{{ lastResult }}</v-alert>

    <div class="lockout-grid">
      <section class="panel">
        <div class="panel-head"><h3>登记挂牌（审阅批次）</h3><span class="muted">提交即生成批次号</span></div>
        <div class="form-grid">
          <v-btn-toggle v-model="scopeLevel" mandatory variant="outlined" density="compact" color="primary" @update:model-value="onScopeLevelChange">
            <v-btn value="device" size="small">单设备</v-btn>
            <v-btn value="zone" size="small">整分区</v-btn>
            <v-btn value="floor" size="small">整楼层</v-btn>
          </v-btn-toggle>
          <v-select v-model="target" :items="targetItems" label="挂牌覆盖范围" density="compact" />
          <v-select v-model="reason" :items="['检修挂牌','故障隔离','夜班调试']" label="挂牌原因" density="compact" />
          <v-text-field v-model="operator" label="调试员" density="compact" />
          <v-text-field v-model="note" label="说明（后到冲突时保留）" density="compact" placeholder="例如：卷帘电机检修" />
          <v-select v-model="failStep" :items="[{title:'正常写入',value:'none'},{title:'模拟：控制器隔离位失败一次',value:'controller:lockout'},{title:'模拟：联动盘确认失败一次',value:'panel:lockout'},{title:'模拟：恢复位失败一次',value:'controller:release'}]" label="写入通道（夜班链路演练）" density="compact" />
          <v-btn color="primary" prepend-icon="mdi-tag-lock" :loading="busy === 'submit'" @click="submitTag">提交挂牌批次</v-btn>
        </div>
        <p class="hint">并发演练：两位调试员可同时点提交同一范围——先到批次生效，后到批次状态为「冲突未生效」，说明与冲突依据完整保留。</p>
      </section>

      <section class="panel">
        <div class="panel-head"><h3>疏散动作优先级队列</h3><span class="muted">挂牌不阻断，按已签优先级继续</span></div>
        <div class="evac-list">
          <div v-for="item in store.evacuationActions" :key="item.ruleId" class="evac-row">
            <v-chip size="small" :color="item.priority === 1 ? 'error' : item.priority === 2 ? 'warning' : 'default'" variant="tonal">P{{ item.priority }}</v-chip>
            <strong>{{ store.devices.find((device) => device.id === item.rule.actionId)?.name }}</strong>
            <span class="muted">{{ item.rule.id }} · 延时 {{ item.rule.delay }}s</span>
            <v-chip v-if="store.taggedDeviceIds.has(item.rule.actionId)" size="x-small" color="success" variant="outlined">动作侧挂牌仍执行</v-chip>
          </div>
          <p v-if="store.evacuationActions.length === 0" class="muted">当前没有可执行的疏散动作。</p>
        </div>
      </section>
    </div>

    <section class="panel mt-3">
      <div class="panel-head"><h3>生效中挂牌</h3><v-chip size="small" color="warning" variant="tonal">{{ store.activeTags.length }} 个范围</v-chip></div>
      <v-table density="compact">
        <thead><tr><th>挂牌</th><th>覆盖范围</th><th>原因 / 说明</th><th>调试员</th><th>生效批次</th><th>生效依据</th><th>操作</th></tr></thead>
        <tbody>
          <tr v-for="tag in store.activeTags" :key="tag.id">
            <td class="mono">{{ tag.id }}</td>
            <td>{{ scopeLabel(tag.scope, store.devices) }}<br /><small class="muted">{{ store.scopeDeviceIds(tag.scope).map((device) => device.name).join('、') }}</small></td>
            <td>{{ tag.reason }}<br /><small class="muted">{{ tag.note }}</small></td>
            <td>{{ tag.operator }}</td>
            <td class="mono">{{ tag.batchNo }}</td>
            <td class="mono">{{ tag.basisId }}</td>
            <td><v-btn size="small" variant="tonal" color="success" prepend-icon="mdi-lock-open-variant-outline" :loading="busy === tag.id" @click="releaseTag(tag.id)">复电摘牌</v-btn></td>
          </tr>
          <tr v-if="store.activeTags.length === 0"><td colspan="7" class="muted">暂无生效挂牌。</td></tr>
        </tbody>
      </v-table>
    </section>

    <section class="panel mt-3">
      <div class="panel-head">
        <h3>审阅批次</h3>
        <div class="head-chips">
          <v-chip size="small" color="warning" variant="tonal">{{ store.failedBatches.length }} 个待续作</v-chip>
          <v-chip size="small" color="error" variant="tonal">{{ store.conflictBatches.length }} 个冲突保留</v-chip>
        </div>
      </div>
      <v-table density="compact">
        <thead><tr><th>批次号</th><th>操作</th><th>范围</th><th>调试员 / 说明</th><th>提交依据</th><th>状态</th><th>失败步骤</th><th>操作</th></tr></thead>
        <tbody>
          <tr v-for="batch in store.batches.slice().reverse()" :key="batch.batchNo" :class="{ 'row-conflict': batch.status === '冲突未生效', 'row-fail': batch.status === '写入失败待续作' }">
            <td class="mono"><strong>{{ batch.batchNo }}</strong><br /><small class="muted">第 {{ batch.attempts }} 次写入</small></td>
            <td>{{ batch.op }}</td>
            <td>{{ scopeLabel(batch.scope, store.devices) }}</td>
            <td>{{ batch.operator }}<br /><small class="muted">{{ batch.note }}</small></td>
            <td class="mono">{{ batch.basisId }}</td>
            <td>
              <v-chip size="small" :color="statusColor(batch.status)" variant="tonal">{{ batch.status }}</v-chip>
              <v-tooltip v-if="batch.conflictDetail" location="top">
                <template #activator="{ props }"><v-chip v-bind="props" size="x-small" variant="text" prepend-icon="mdi-information-outline">冲突依据</v-chip></template>
                <div style="max-width:340px">{{ batch.conflictDetail }}<br />本批次说明「{{ batch.note }}」已保留，未覆盖先到批次。</div>
              </v-tooltip>
            </td>
            <td>{{ batch.failStep ? stepLabels[batch.failStep] ?? batch.failStep : '—' }}</td>
            <td>
              <v-btn v-if="batch.status === '写入失败待续作'" size="small" variant="tonal" prepend-icon="mdi-play-circle-outline" :loading="busy === batch.batchNo" @click="resume(batch.batchNo)">按批次号续作</v-btn>
              <v-btn v-else-if="store.canResumeConflict(batch.batchNo)" size="small" variant="tonal" prepend-icon="mdi-refresh-auto" :loading="busy === batch.batchNo" @click="resume(batch.batchNo)">冲突依据已失效，按批次号续作</v-btn>
              <span v-else class="muted">—</span>
            </td>
          </tr>
        </tbody>
      </v-table>
    </section>

    <section class="panel mt-3">
      <div class="panel-head"><h3>报警 / 复电回传</h3><span class="muted">重复回传幂等，已确认不回退待确认</span></div>
      <div class="callback-actions">
        <v-btn size="small" variant="tonal" prepend-icon="mdi-bell-alert-outline" @click="emitCallback('D-01-01', '报警')">D-01-01 报警回传</v-btn>
        <v-btn size="small" variant="tonal" prepend-icon="mdi-bell-badge-outline" @click="emitCallback('D-01-01', '报警')">D-01-01 再次报警（重复）</v-btn>
        <v-btn size="small" variant="tonal" color="success" prepend-icon="mdi-power-plug-outline" @click="emitCallback('A-01-02', '复电')">A-01-02 复电回传</v-btn>
      </div>
      <v-table density="compact">
        <thead><tr><th>记录</th><th>设备</th><th>事件</th><th>接收次数</th><th>关联批次</th><th>状态</th><th>操作</th></tr></thead>
        <tbody>
          <tr v-for="record in store.callbacks.slice().reverse()" :key="record.id">
            <td class="mono">{{ record.id }}</td>
            <td>{{ store.devices.find((device) => device.id === record.deviceId)?.name ?? record.deviceId }}</td>
            <td>{{ record.event }}</td>
            <td>{{ record.duplicates + 1 }} 次<small v-if="record.duplicates" class="muted">（重复 {{ record.duplicates }} 次，仅计数）</small></td>
            <td class="mono">{{ record.batchNo ?? '—' }}</td>
            <td>
              <v-chip size="small" :color="record.status === '已确认' ? 'success' : 'warning'" variant="tonal">
                {{ record.status }}
              </v-chip>
              <small v-if="record.status === '已确认' && record.duplicates" class="muted">重复回传未改回待确认</small>
            </td>
            <td>
              <v-btn v-if="record.status === '待确认'" size="small" color="primary" variant="tonal" @click="store.acknowledgeCallback(record.id)">确认结果</v-btn>
              <v-btn v-if="record.batchNo && store.failedBatches.some((batch) => batch.batchNo === record.batchNo)" size="small" variant="tonal" prepend-icon="mdi-play-circle-outline" :loading="busy === record.batchNo" @click="resume(record.batchNo!)">按关联批次续作</v-btn>
              <span v-if="record.status === '已确认' && !record.batchNo" class="muted">—</span>
            </td>
          </tr>
          <tr v-if="store.callbacks.length === 0"><td colspan="7" class="muted">暂无回传记录，点击上方按钮模拟夜班同时到达的报警与复电。</td></tr>
        </tbody>
      </v-table>
    </section>
  </section>
</template>

<style scoped>
.lockout-grid { display: grid; grid-template-columns: minmax(0,1fr) minmax(0,1fr); gap: 14px; }
.form-grid { display: grid; gap: 10px; padding: 14px 16px 8px; }
.hint { margin: 4px 16px 16px; color: #7f8b90; font-size: 11px; line-height: 1.6; }
.evac-list { display: grid; gap: 8px; padding: 12px 16px 16px; }
.evac-row { display: flex; align-items: center; gap: 10px; font-size: 13px; flex-wrap: wrap; }
.head-chips { display: flex; gap: 6px; }
.mono { font-family: ui-monospace,monospace; font-size: 12px; }
.muted { color: #849096; }
.row-conflict { background: #fdf1ee; }
.row-fail { background: #fdf7ec; }
.callback-actions { display: flex; gap: 8px; flex-wrap: wrap; padding: 12px 16px; }
@media (max-width: 1000px) { .lockout-grid { grid-template-columns: 1fr; } }
</style>
