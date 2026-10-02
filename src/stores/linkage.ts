import { computed, ref, watch } from 'vue'
import { defineStore } from 'pinia'
import {
  basisFingerprint,
  confirmCallback,
  conflictBatch,
  coveredDeviceIds,
  evaluateRule,
  evacuationQueue,
  findConflictingTag,
  formatBasisId,
  formatBatchNo,
  formatTagId,
  ingestCallback,
  planBatch,
  scopeCovers,
  type AlarmCallback,
  type BatchInput,
  type CallbackEvent,
  type LockoutTag,
  type ReviewBatch,
  type RuleEvaluation,
  type TagScope,
} from '../linkage/domain'
import { LOCKOUT_STEPS, RELEASE_STEPS, armNextWriteFailure, writeStep } from '../linkage/controller'

export type DeviceType = '感烟探测器' | '感温探测器' | '手动报警按钮' | '输入模块' | '输出模块' | '排烟风机' | '防火卷帘' | '消防广播' | '电梯'
export type Device = { id: string; name: string; type: DeviceType; floor: string; zone: string; address: string }
export type Rule = {
  id: string
  triggerId: string
  actionId: string
  delay: number
  interlock: string
  priority: 1 | 2 | 3
  suppression: string
  enabled: boolean
}
export type Validation = { id: string; severity: '错误' | '警告' | '提示'; ruleIds: string[]; title: string; detail: string; suggestion: string }

export const seedDevices: Device[] = [
  { id: 'D-01-01', name: '一层大厅感烟 01', type: '感烟探测器', floor: '1F', zone: 'A 区', address: '1-A-01-01' },
  { id: 'D-01-02', name: '一层大厅感烟 02', type: '感烟探测器', floor: '1F', zone: 'A 区', address: '1-A-01-02' },
  { id: 'D-01-11', name: '一层东侧手报', type: '手动报警按钮', floor: '1F', zone: 'A 区', address: '1-A-02-01' },
  { id: 'A-01-01', name: '一层排烟风机 PF-1', type: '排烟风机', floor: '1F', zone: 'A 区', address: '1-F-01-01' },
  { id: 'A-01-02', name: '中庭防火卷帘 01', type: '防火卷帘', floor: '1F', zone: '中庭', address: '1-R-01-01' },
  { id: 'A-01-03', name: '一层消防广播', type: '消防广播', floor: '1F', zone: 'A 区', address: '1-B-01-01' },
  { id: 'D-02-01', name: '二层机房感温 01', type: '感温探测器', floor: '2F', zone: 'B 区', address: '2-B-01-01' },
  { id: 'D-02-02', name: '二层机房感烟 01', type: '感烟探测器', floor: '2F', zone: 'B 区', address: '2-B-01-02' },
  { id: 'A-02-01', name: '二层排烟风机 PF-2', type: '排烟风机', floor: '2F', zone: 'B 区', address: '2-F-01-01' },
  { id: 'A-02-02', name: '1 号客梯归位', type: '电梯', floor: '2F', zone: 'B 区', address: '2-L-01-01' },
]

export const seedRules: Rule[] = [
  { id: 'R-001', triggerId: 'D-01-01', actionId: 'A-01-01', delay: 0, interlock: '卷帘全开后启动', priority: 1, suppression: '无', enabled: true },
  { id: 'R-002', triggerId: 'D-01-01', actionId: 'A-01-03', delay: 5, interlock: '无', priority: 2, suppression: '手动广播优先', enabled: true },
  { id: 'R-003', triggerId: 'D-01-02', actionId: 'A-01-02', delay: 0, interlock: '排烟风机运行', priority: 1, suppression: '无', enabled: true },
  { id: 'R-004', triggerId: 'D-01-11', actionId: 'A-01-03', delay: 3, interlock: '无', priority: 1, suppression: '无', enabled: true },
  { id: 'R-005', triggerId: 'D-02-01', actionId: 'A-02-01', delay: 0, interlock: '防火阀开启反馈', priority: 1, suppression: '无', enabled: true },
  { id: 'R-006', triggerId: 'D-02-01', actionId: 'A-02-02', delay: 10, interlock: '轿厢无人确认', priority: 2, suppression: '消防电梯模式', enabled: true },
  { id: 'R-007', triggerId: 'D-02-02', actionId: 'A-01-01', delay: 0, interlock: '无', priority: 3, suppression: '无', enabled: false },
  { id: 'R-008', triggerId: 'D-01-01', actionId: 'A-02-02', delay: 0, interlock: '无', priority: 1, suppression: '无', enabled: true },
]

/** 夜班初始场景：中庭防火卷帘检修挂牌（R-003 动作侧挂牌，立即失效） */
function seedTag(): LockoutTag {
  return {
    id: 'TAG-20261002-001',
    deviceId: 'A-01-02',
    scope: { level: 'device', target: 'A-01-02' },
    reason: '检修挂牌',
    note: '夜班卷帘电机检修，复电后摘牌',
    operator: '值班调试员',
    batchNo: 'B-20261002-001',
    basisId: 'BASIS-0001',
    createdAt: Date.parse('2026-10-02T01:20:00+08:00'),
    active: true,
  }
}

function seedBatch(): ReviewBatch {
  return {
    batchNo: 'B-20261002-001',
    op: '挂牌',
    scope: { level: 'device', target: 'A-01-02' },
    reason: '检修挂牌',
    note: '夜班卷帘电机检修，复电后摘牌',
    operator: '值班调试员',
    createdAt: Date.parse('2026-10-02T01:20:00+08:00'),
    basisId: 'BASIS-0001',
    status: '已生效',
    tagId: 'TAG-20261002-001',
    attempts: 1,
  }
}

const STORAGE_KEY = 'fire-linkage-draft-v2'

export const useLinkageStore = defineStore('linkage', () => {
  const restored = (() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      return raw ? JSON.parse(raw) : null
    } catch {
      return null
    }
  })()

  const devices = ref<Device[]>(restored?.devices ?? structuredClone(seedDevices))
  const rules = ref<Rule[]>(restored?.rules ?? structuredClone(seedRules))
  const revision = ref(restored?.revision ?? 8)
  const locked = ref(restored?.locked ?? false)
  const acceptedChanges = ref<string[]>(restored?.acceptedChanges ?? ['CH-01'])
  const selectedRuleIds = ref<string[]>([])

  const tags = ref<LockoutTag[]>(restored?.tags ?? [seedTag()])
  const batches = ref<ReviewBatch[]>(restored?.batches ?? [seedBatch()])
  const callbacks = ref<AlarmCallback[]>(restored?.callbacks ?? [])
  const signedPriority = ref<Record<string, 1 | 2 | 3>>(restored?.signedPriority ?? {})
  const basisSeq = ref<number>(restored?.basisSeq ?? 1)
  const batchSeq = ref<number>(restored?.batchSeq ?? 1)
  const tagSeq = ref<number>(restored?.tagSeq ?? 1)
  const cbSeq = ref<number>(restored?.cbSeq ?? 0)

  let basisFingerprintValue = basisFingerprint(tags.value, devices.value)
  const basisId = ref<string>(restored?.basisId ?? formatBasisId(basisSeq.value))

  /** 挂牌覆盖范围变化后推进共用依据；设备集合没变（如仅改说明）不推进 */
  function commitBasis() {
    const next = basisFingerprint(tags.value, devices.value)
    if (next !== basisFingerprintValue) {
      basisFingerprintValue = next
      basisSeq.value += 1
      basisId.value = formatBasisId(basisSeq.value)
    }
  }

  const taggedDeviceIds = computed<Set<string>>(() => coveredDeviceIds(tags.value, devices.value))

  const evaluationCtx = computed(() => ({
    devices: devices.value,
    tagged: taggedDeviceIds.value,
    signedPriority: signedPriority.value,
    basisId: basisId.value,
  }))

  /** 规则重算结果：矩阵、依赖图、疏散队列全部以此为唯一依据，不再只看 enabled */
  const evaluations = computed<Map<string, RuleEvaluation>>(() => {
    const map = new Map<string, RuleEvaluation>()
    for (const rule of rules.value) map.set(rule.id, evaluateRule(rule, evaluationCtx.value))
    return map
  })
  function evaluationOf(ruleId: string): RuleEvaluation | undefined {
    return evaluations.value.get(ruleId)
  }

  /** 疏散动作：触发侧未挂牌的疏散设备动作继续执行，按已签优先级排序 */
  const evacuationActions = computed(() => evacuationQueue(rules.value, evaluationCtx.value))

  const blockedCount = computed(() => [...evaluations.value.values()].filter((item) => item.blocked).length)

  const activeTags = computed(() => tags.value.filter((tag) => tag.active && !tag.reserved))

  const failedBatches = computed(() => batches.value.filter((batch) => batch.status === '写入失败待续作'))
  const conflictBatches = computed(() => batches.value.filter((batch) => batch.status === '冲突未生效'))
  /** 冲突批次只有在先到占用已消失（摘牌或先到批次撤销）时，才可按原批次号续作 */
  function canResumeConflict(batchNo: string): boolean {
    const batch = batches.value.find((item) => item.batchNo === batchNo)
    if (!batch || batch.status !== '冲突未生效') return false
    return !findConflictingTag(tags.value, batch.scope, devices.value)
  }

  const validations = computed<Validation[]>(() => {
    const result: Validation[] = []
    const triggers = devices.value.filter((device) => ['感烟探测器', '感温探测器', '手动报警按钮', '输入模块'].includes(device.type))
    for (const trigger of triggers) {
      if (taggedDeviceIds.value.has(trigger.id)) {
        result.push({ id: `tagged-trigger-${trigger.id}`, severity: '提示', ruleIds: rules.value.filter((rule) => rule.triggerId === trigger.id).map((rule) => rule.id), title: `${trigger.name} 挂牌隔离中`, detail: '报警源处于挂牌覆盖范围，联动规则暂时不参与满足判定。', suggestion: '夜班结束摘牌复电后规则自动恢复。' })
        continue
      }
      const effective = rules.value.filter((rule) => rule.triggerId === trigger.id && evaluations.value.get(rule.id)?.effective)
      if (effective.length === 0) {
        result.push({ id: `missing-${trigger.id}`, severity: '错误', ruleIds: [], title: `${trigger.name} 缺少联动动作`, detail: '报警点未配置任何启用且未被挂牌阻断的因果规则。', suggestion: '至少配置广播、排烟或疏散相关动作。' })
      }
      const actionCount = new Map<string, number>()
      effective.forEach((rule) => actionCount.set(rule.actionId, (actionCount.get(rule.actionId) ?? 0) + 1))
      actionCount.forEach((count, actionId) => {
        if (count > 1) result.push({ id: `duplicate-${trigger.id}-${actionId}`, severity: '警告', ruleIds: effective.filter((rule) => rule.actionId === actionId).map((rule) => rule.id), title: `${trigger.name} 存在重复动作`, detail: `同一个动作 ${actionId} 被重复配置 ${count} 次。`, suggestion: '合并规则或明确主备关系。' })
      })
    }
    rules.value.filter((rule) => rule.enabled).forEach((rule) => {
      const trigger = devices.value.find((device) => device.id === rule.triggerId)
      const action = devices.value.find((device) => device.id === rule.actionId)
      if (trigger && action && trigger.zone !== action.zone && rule.suppression === '无') {
        result.push({ id: `cross-${rule.id}`, severity: '警告', ruleIds: [rule.id], title: `${rule.id} 跨区联动未配置抑制`, detail: `${trigger.zone} 报警将直接触发 ${action.zone} 动作。`, suggestion: '确认疏散边界并增加分区确认或抑制条件。' })
      }
      if (rule.interlock && rule.delay > 5 && rule.priority === 1) {
        result.push({ id: `contradiction-${rule.id}`, severity: '错误', ruleIds: [rule.id], title: `${rule.id} 互锁与高优先级延时冲突`, detail: '一级优先规则在互锁未明确反馈前延时超过 5 秒。', suggestion: '缩短延时或改为反馈后触发。' })
      }
    })
    // 挂牌覆盖导致规则失效：挂牌是临时检修依据，不算矩阵错误，但要让每条失效规则可见
    evaluations.value.forEach((item, ruleId) => {
      if (item.blocked) {
        const rule = rules.value.find((entry) => entry.id === ruleId)
        const action = devices.value.find((device) => device.id === rule?.actionId)
        result.push({
          id: `lockout-${ruleId}`,
          severity: '提示',
          ruleIds: [ruleId],
          title: `${ruleId} 因挂牌覆盖失效（依据 ${item.basisId}）`,
          detail: item.blockReason ?? '挂牌覆盖中',
          suggestion: item.evacuation && action ? `${action.name}属于疏散动作，仍按已签优先级 P${item.priority} 继续执行` : '摘牌且依据推进后自动参与满足判定，无需改动矩阵',
        })
      }
    })
    return result
  })

  watch([devices, tags, batches, callbacks, signedPriority, basisId, basisSeq, batchSeq, tagSeq, cbSeq, rules, revision, locked, acceptedChanges], () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      devices: devices.value, rules: rules.value, revision: revision.value, locked: locked.value, acceptedChanges: acceptedChanges.value,
      tags: tags.value, batches: batches.value, callbacks: callbacks.value, signedPriority: signedPriority.value,
      basisId: basisId.value, basisSeq: basisSeq.value, batchSeq: batchSeq.value, tagSeq: tagSeq.value, cbSeq: cbSeq.value,
    }))
  }, { deep: true })

  function updateRule(id: string, patch: Partial<Rule>) {
    if (locked.value) return
    const rule = rules.value.find((item) => item.id === id)
    if (rule) Object.assign(rule, patch)
  }

  function addRule() {
    if (locked.value) return
    rules.value.push({
      id: `R-${String(rules.value.length + 1).padStart(3, '0')}`,
      triggerId: devices.value[0]?.id ?? '',
      actionId: devices.value.at(-1)?.id ?? '',
      delay: 0,
      interlock: '无',
      priority: 2,
      suppression: '无',
      enabled: true,
    })
    revision.value += 1
  }

  function batchUpdate(patch: Partial<Rule>) {
    if (locked.value) return
    rules.value = rules.value.map((rule) => (selectedRuleIds.value.includes(rule.id) ? { ...rule, ...patch } : rule))
  }

  function toggleSelected(enabled: boolean) {
    batchUpdate({ enabled })
  }

  function lockBaseline() {
    // 签字时固化“已签优先级”，之后挂牌/改矩阵都不能改变疏散动作的执行顺序
    signedPriority.value = Object.fromEntries(rules.value.map((rule) => [rule.id, rule.priority]))
    locked.value = true
    revision.value += 1
  }

  function unlock() {
    locked.value = false
  }

  function scopeDeviceIds(scope: TagScope): Device[] {
    return devices.value.filter((device) => scopeCovers(scope, device))
  }

  /**
   * 挂牌提交（两名调试员并发时先后调用）：
   * 先到批次先占位并写入，生效；后到批次不覆盖，保留说明与冲突依据。
   */
  async function submitLockoutBatch(input: BatchInput): Promise<ReviewBatch> {
    const now = new Date()
    batchSeq.value += 1
    const batchNo = formatBatchNo(now, batchSeq.value)
    const createdAt = Date.now()
    const batch = planBatch({ ...input, batchNo, basisId: basisId.value, createdAt })

    const winner = findConflictingTag(tags.value, input.scope, devices.value)
    if (winner) {
      const winnerBatch = batches.value.find((item) => item.batchNo === winner.batchNo)
      const conflicted = conflictBatch(batch, winner, winnerBatch, devices.value)
      batches.value.push(conflicted)
      return conflicted
    }

    tagSeq.value += 1
    const tagId = formatTagId(now, tagSeq.value)
    const anchor = scopeDeviceIds(input.scope)[0]
    const tag: LockoutTag = {
      id: tagId,
      deviceId: anchor?.id ?? '',
      scope: input.scope,
      reason: input.reason,
      note: input.note,
      operator: input.operator,
      batchNo,
      basisId: basisId.value,
      createdAt,
      active: false,
      reserved: true,
    }
    tags.value.push(tag)
    batch.tagId = tagId
    batches.value.push(batch)

    const outcome = await runLockoutWrites(batch, tag)
    return outcome
  }

  async function runLockoutWrites(batch: ReviewBatch, tag: LockoutTag): Promise<ReviewBatch> {
    batch.attempts += 1
    const startIndex = batch.failStep ? LOCKOUT_STEPS.findIndex((step) => step.name === batch.failStep) : 0
    for (const step of LOCKOUT_STEPS.slice(Math.max(0, startIndex))) {
      const result = await writeStep(batch.batchNo, step)
      if (!result.ok) {
        batch.status = '写入失败待续作'
        batch.failStep = step.name
        // 写入失败：控制器未生效（不进入覆盖集合），但保留批次占位（reserved=true），
        // 后续同范围提交仍按先到次序登记冲突，待本批次按批次号续作
        tag.reserved = true
        tag.active = false
        return batch
      }
    }
    tag.reserved = false
    tag.active = true
    batch.status = '已生效'
    batch.failStep = undefined
    commitBasis()
    tag.basisId = basisId.value
    batch.basisId = basisId.value
    return batch
  }

  async function runReleaseWrites(batch: ReviewBatch, tag: LockoutTag): Promise<ReviewBatch> {
    batch.attempts += 1
    const startIndex = batch.failStep ? RELEASE_STEPS.findIndex((step) => step.name === batch.failStep) : 0
    for (const step of RELEASE_STEPS.slice(Math.max(0, startIndex))) {
      const result = await writeStep(batch.batchNo, step)
      if (!result.ok) {
        batch.status = '写入失败待续作'
        batch.failStep = step.name
        return batch
      }
    }
    tag.active = false
    tag.removedAt = Date.now()
    batch.status = '已撤销'
    batch.failStep = undefined
    commitBasis()
    batch.basisId = basisId.value
    return batch
  }

  /** 摘牌提交（复电后恢复），同样走批次写入，失败可续作 */
  async function submitReleaseBatch(tagId: string, input: { note: string; operator: string }): Promise<ReviewBatch> {
    const tag = tags.value.find((item) => item.id === tagId)
    if (!tag || !tag.active) throw new Error('挂牌不存在或已摘除')
    const now = new Date()
    batchSeq.value += 1
    const batch: ReviewBatch = {
      batchNo: formatBatchNo(now, batchSeq.value),
      op: '摘牌',
      scope: JSON.parse(JSON.stringify(tag.scope)),
      reason: tag.reason,
      note: input.note,
      operator: input.operator,
      createdAt: Date.now(),
      basisId: basisId.value,
      status: '写入失败待续作',
      tagId,
      attempts: 0,
    }
    batches.value.push(batch)
    return runReleaseWrites(batch, tag)
  }

  /**
   * 写入失败后按批次号续作：
   * 从失败步骤继续，不重新发号；挂牌批次在当前依据下重新做冲突校验，
   * 依据已变且覆盖不再冲突时可以续作生效。
   */
  async function resumeBatch(batchNo: string): Promise<ReviewBatch> {
    const batch = batches.value.find((item) => item.batchNo === batchNo)
    if (!batch || (batch.status !== '写入失败待续作' && batch.status !== '冲突未生效')) {
      throw new Error('该批次当前不可续作')
    }
    let tag = tags.value.find((item) => item.id === batch.tagId)
    if (batch.op === '摘牌') {
      if (!tag) throw new Error('找不到批次对应的挂牌')
      return runReleaseWrites(batch, tag)
    }
    if (batch.status === '冲突未生效') {
      const winner = findConflictingTag(tags.value, batch.scope, devices.value)
      if (winner) {
        const winnerBatch = batches.value.find((item) => item.batchNo === winner.batchNo)
        return conflictBatch(batch, winner, winnerBatch, devices.value)
      }
    }
    if (!tag) {
      tagSeq.value += 1
      tag = {
        id: batch.tagId ?? formatTagId(new Date(), tagSeq.value),
        deviceId: scopeDeviceIds(batch.scope)[0]?.id ?? '',
        scope: JSON.parse(JSON.stringify(batch.scope)),
        reason: batch.reason,
        note: batch.note,
        operator: batch.operator,
        batchNo: batch.batchNo,
        basisId: batch.basisId,
        createdAt: batch.createdAt,
        active: false,
        reserved: true,
      }
      tags.value.push(tag)
      batch.tagId = tag.id
    } else {
      tag.reserved = true
    }
    return runLockoutWrites(batch, tag)
  }

  /** 接收报警/复电回传；重复回传幂等，绝不把已确认改回待确认 */
  function receiveCallback(input: { deviceId: string; event: CallbackEvent; batchNo?: string; note?: string }): { record: AlarmCallback; duplicate: boolean } {
    cbSeq.value += 1
    const outcome = ingestCallback(callbacks.value, {
      id: `CB-${String(cbSeq.value).padStart(4, '0')}`,
      deviceId: input.deviceId,
      event: input.event,
      at: Date.now(),
      batchNo: input.batchNo,
      note: input.note,
    })
    const index = callbacks.value.findIndex((item) => item.deviceId === input.deviceId && item.event === input.event)
    if (index >= 0) callbacks.value[index] = outcome.record
    else callbacks.value.push(outcome.record)
    return outcome
  }

  function acknowledgeCallback(id: string) {
    const index = callbacks.value.findIndex((item) => item.id === id)
    if (index < 0) return
    callbacks.value[index] = confirmCallback(callbacks.value[index], Date.now())
  }

  /** 复电回传关联了写入失败批次时，按批次号续作 */
  async function resumeBatchFromCallback(id: string): Promise<ReviewBatch | undefined> {
    const record = callbacks.value.find((item) => item.id === id)
    if (!record?.batchNo) return undefined
    return resumeBatch(record.batchNo)
  }

  /** 演示用：让下一次指定步骤写入失败一次 */
  function armFailure(step = 'controller:lockout') {
    armNextWriteFailure(step)
  }

  return {
    devices, rules, revision, locked, acceptedChanges, selectedRuleIds,
    tags, batches, callbacks, basisId, signedPriority,
    activeTags, failedBatches, conflictBatches, canResumeConflict,
    taggedDeviceIds, evaluations, evacuationActions, blockedCount, validations,
    evaluationOf, scopeDeviceIds,
    updateRule, addRule, batchUpdate, toggleSelected, lockBaseline, unlock,
    submitLockoutBatch, submitReleaseBatch, resumeBatch,
    receiveCallback, acknowledgeCallback, resumeBatchFromCallback, armFailure,
  }
})
