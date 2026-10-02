import { computed, ref, watch } from 'vue'
import { defineStore } from 'pinia'
import { useLinkageStore, type Rule } from './linkage'

// 检修挂牌、审阅批次与现场回传共用同一份依据：
// 规则校验读取挂牌状态，批次提交写入挂牌，回传确认作用于同一批设备。

export type TagStatus = '待签' | '已签' | '已撤销'
export type LockoutTag = {
  id: string
  batchId: string
  deviceIds: string[]
  reason: string
  applicant: string
  status: TagStatus
  signedPriority: 1 | 2 | 3 | null
  createdAt: number
  signedAt?: number
}

export type BatchStatus = '已生效' | '已驳回' | '部分写入' | '已完成续作'
export type TagBatch = {
  id: string
  applicant: string
  reason: string
  deviceIds: string[]
  status: BatchStatus
  itemsTotal: number
  itemsApplied: number
  submittedAt: number
  effectiveAt?: number
  conflictBatchId?: string
  conflictDetail?: string
  resumeCount: number
  failedAttempts: number
}

export type FeedbackKind = '报警回传' | '动作反馈' | '复电'
export type FeedbackState = '待确认' | '已确认'
export type FeedbackRecord = {
  id: string
  batchId: string
  deviceId: string
  ruleId?: string
  kind: FeedbackKind
  message: string
  state: FeedbackState
  receivedAt: number
  confirmedAt?: number
  duplicateCount: number
}

// 疏散类动作：挂牌期间仍按已签优先级继续
const EVACUATION_TYPES = ['排烟风机', '消防广播']

function now() {
  return Date.now()
}

export const useTagoutStore = defineStore('tagout', () => {
  const saved = localStorage.getItem('fire-linkage-tagout-v1')
  const restored = saved ? JSON.parse(saved) : null

  const tags = ref<LockoutTag[]>(restored?.tags ?? [])
  const batches = ref<TagBatch[]>(restored?.batches ?? [])
  const feedbacks = ref<FeedbackRecord[]>(restored?.feedbacks ?? [])
  const tagSeq = ref(restored?.tagSeq ?? 1)
  const batchSeq = ref(restored?.batchSeq ?? 1)
  const fbSeq = ref(restored?.fbSeq ?? 1)

  watch([tags, batches, feedbacks, tagSeq, batchSeq, fbSeq], () => {
    localStorage.setItem('fire-linkage-tagout-v1', JSON.stringify({
      tags: tags.value,
      batches: batches.value,
      feedbacks: feedbacks.value,
      tagSeq: tagSeq.value,
      batchSeq: batchSeq.value,
      fbSeq: fbSeq.value,
    }))
  }, { deep: true })

  // ---- 挂牌依据 ----
  // 待签与已签的挂牌都占用设备，已撤销的不再闭锁
  const hangingTags = computed(() => tags.value.filter((tag) => tag.status === '待签' || tag.status === '已签'))
  const activeTags = computed(() => tags.value.filter((tag) => tag.status === '已签'))

  function coveringTag(deviceId: string): LockoutTag | undefined {
    return hangingTags.value.find((tag) => tag.deviceIds.includes(deviceId))
  }

  function isDeviceBlocked(deviceId: string): boolean {
    return !!coveringTag(deviceId)
  }

  // 规则动作是否被挂牌闭锁；疏散动作按已签优先级继续
  function ruleBlockState(rule: Rule): 'blocked' | 'continued' | null {
    const linkage = useLinkageStore()
    const action = linkage.devices.find((device) => device.id === rule.actionId)
    if (!action) return null
    const tag = coveringTag(rule.actionId)
    if (!tag) return null
    if (EVACUATION_TYPES.includes(action.type) && rule.priority <= (tag.signedPriority ?? 1)) return 'continued'
    return 'blocked'
  }

  // 启用但被闭锁的规则不再视为满足
  function isRuleSatisfied(rule: Rule): boolean {
    return rule.enabled && ruleBlockState(rule) !== 'blocked'
  }

  const blockedRuleIds = computed(() => {
    const linkage = useLinkageStore()
    return linkage.rules.filter((rule) => rule.enabled && ruleBlockState(rule) === 'blocked').map((rule) => rule.id)
  })

  const continuedRuleIds = computed(() => {
    const linkage = useLinkageStore()
    return linkage.rules.filter((rule) => rule.enabled && ruleBlockState(rule) === 'continued').map((rule) => rule.id)
  })

  // ---- 挂牌签认与覆盖范围 ----
  function signTag(tagId: string, priority: 1 | 2 | 3) {
    const tag = tags.value.find((item) => item.id === tagId)
    if (!tag || tag.status !== '待签') return
    tag.status = '已签'
    tag.signedPriority = priority
    tag.signedAt = now()
  }

  function revokeTag(tagId: string) {
    const tag = tags.value.find((item) => item.id === tagId)
    if (!tag || tag.status === '已撤销') return
    tag.status = '已撤销'
  }

  // 覆盖范围一改，依赖它的规则立即失效重算（计算属性自动重算）
  function updateTagCoverage(tagId: string, deviceIds: string[]) {
    const tag = tags.value.find((item) => item.id === tagId)
    if (!tag) return
    tag.deviceIds = deviceIds
  }

  // ---- 审阅批次提交 ----
  function genBatchId(): string {
    const day = new Date().toISOString().slice(0, 10).replace(/-/g, '')
    return `B-${day}-${String(batchSeq.value++).padStart(3, '0')}`
  }

  function genTagId(): string {
    return `TAG-${String(tagSeq.value++).padStart(3, '0')}`
  }

  function rejectBatch(batch: TagBatch, conflict: LockoutTag) {
    batch.status = '已驳回'
    batch.conflictBatchId = conflict.batchId
    batch.conflictDetail = `申请覆盖 ${batch.deviceIds.join('、')}，但设备已被先到批次 ${conflict.batchId} 的挂牌 ${conflict.id} 占用（申请人 ${conflict.applicant}）。先到批次已生效，本批次保留说明，不予写入。`
    batches.value.push(batch)
  }

  function submitBatch(input: { applicant: string; reason: string; deviceIds: string[]; forceFailure?: boolean }): TagBatch {
    const id = genBatchId()
    const target = [...new Set(input.deviceIds)]
    const batch: TagBatch = {
      id,
      applicant: input.applicant,
      reason: input.reason,
      deviceIds: target,
      status: '部分写入',
      itemsTotal: target.length,
      itemsApplied: 0,
      submittedAt: now(),
      resumeCount: 0,
      failedAttempts: 0,
    }

    // 先到先得：同一台设备已有挂牌占用时，后到批次驳回并保留冲突依据
    const conflict = hangingTags.value.find((tag) => tag.deviceIds.some((deviceId) => target.includes(deviceId)))
    if (conflict) {
      rejectBatch(batch, conflict)
      return batch
    }

    // 模拟批量写入：可强制失败，用于演练按批次号续作
    const fail = !!input.forceFailure
    const appliedCount = fail ? Math.max(0, target.length - 1) : target.length
    const applied = target.slice(0, appliedCount)
    const tag: LockoutTag = {
      id: genTagId(),
      batchId: id,
      deviceIds: applied,
      reason: input.reason,
      applicant: input.applicant,
      status: '待签',
      signedPriority: null,
      createdAt: now(),
    }
    tags.value.push(tag)

    batch.itemsApplied = applied.length
    batch.failedAttempts = fail ? 1 : 0
    if (applied.length === target.length) {
      batch.status = '已生效'
      batch.effectiveAt = now()
    }
    batches.value.push(batch)
    return batch
  }

  // 模拟两名调试员同时提交同一挂牌：先到的批次生效，后到者保留说明和冲突依据
  function submitConcurrent(input: { applicantA: string; applicantB: string; reason: string; deviceIds: string[] }): { a: TagBatch; b: TagBatch } {
    const a = submitBatch({ applicant: input.applicantA, reason: input.reason, deviceIds: input.deviceIds })
    const b = submitBatch({ applicant: input.applicantB, reason: input.reason, deviceIds: input.deviceIds })
    return { a, b }
  }

  // 写入失败后按批次号续作：已写入的项幂等跳过，剩余项继续写入
  function resumeBatch(batchId: string): TagBatch | undefined {
    const batch = batches.value.find((item) => item.id === batchId)
    if (!batch || batch.status !== '部分写入') return batch
    const tag = tags.value.find((item) => item.batchId === batchId)
    if (!tag) return batch

    const remaining = batch.deviceIds.filter((deviceId) => !tag.deviceIds.includes(deviceId))
    // 幂等：已写入项不重复提交；剩余项先做冲突检查
    const conflicts = hangingTags.value.filter((item) => item.id !== tag.id && item.deviceIds.some((deviceId) => remaining.includes(deviceId)))
    if (conflicts.length > 0) {
      const winner = conflicts[0]
      batch.conflictBatchId = winner.batchId
      batch.conflictDetail = `续作时剩余设备 ${remaining.join('、')} 已被先到批次 ${winner.batchId} 的挂牌 ${winner.id} 占用（申请人 ${winner.applicant}），该部分不再写入；已写入 ${tag.deviceIds.length} 项保持有效。`
      return batch
    }

    // 续作写入（演练中不再失败）
    tag.deviceIds = [...tag.deviceIds, ...remaining]
    batch.itemsApplied = batch.itemsTotal
    batch.status = '已完成续作'
    batch.effectiveAt = now()
    batch.resumeCount += 1
    return batch
  }

  // ---- 报警回传 / 复电确认 ----
  function genFbId(): string {
    return `FB-${String(fbSeq.value++).padStart(3, '0')}`
  }

  function receiveFeedback(input: { deviceId: string; ruleId?: string; kind: FeedbackKind; message: string }): FeedbackRecord {
    const key = `${input.deviceId}|${input.ruleId ?? ''}|${input.kind}`
    const existing = feedbacks.value.find((fb) => `${fb.deviceId}|${fb.ruleId ?? ''}|${fb.kind}` === key)
    if (existing) {
      // 重复回传只计数，不改变状态
      existing.duplicateCount += 1
      return existing
    }
    const record: FeedbackRecord = {
      id: genFbId(),
      batchId: `FB-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}`,
      deviceId: input.deviceId,
      ruleId: input.ruleId,
      kind: input.kind,
      message: input.message,
      state: '待确认',
      receivedAt: now(),
      duplicateCount: 0,
    }
    // 复电与挂牌同时到达：复电不解除闭锁
    if (input.kind === '复电' && isDeviceBlocked(input.deviceId)) {
      record.message = `${input.message}（复电已送达，但挂牌仍闭锁该设备，动作不恢复）`
    }
    feedbacks.value.push(record)
    return record
  }

  // 已确认结果单向不可逆：重复回传不能改回待确认
  function confirmFeedback(id: string) {
    const fb = feedbacks.value.find((item) => item.id === id)
    if (!fb || fb.state === '已确认') return
    fb.state = '已确认'
    fb.confirmedAt = now()
  }

  const pendingFeedbackCount = computed(() => feedbacks.value.filter((fb) => fb.state === '待确认').length)

  return {
    tags, batches, feedbacks,
    hangingTags, activeTags,
    coveringTag, isDeviceBlocked, ruleBlockState, isRuleSatisfied,
    blockedRuleIds, continuedRuleIds,
    signTag, revokeTag, updateTagCoverage,
    submitBatch, submitConcurrent, resumeBatch,
    receiveFeedback, confirmFeedback,
    pendingFeedbackCount,
  }
})
