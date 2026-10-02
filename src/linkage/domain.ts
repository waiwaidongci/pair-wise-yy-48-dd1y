import type { Device, Rule } from '../stores/linkage'

/**
 * 挂牌 / 依据 / 批次 / 回传的纯领域逻辑。
 * 这一层不依赖 Vue 与 Pinia，所有函数均可单测，store 只负责状态与副作用。
 */

/** 疏散动作设备：挂牌检修不阻断这些动作，按已签优先级继续执行 */
export const EVACUATION_DEVICE_TYPES = ['排烟风机', '消防广播', '电梯'] as const

export function isEvacuationDevice(device: Device | undefined): boolean {
  return !!device && (EVACUATION_DEVICE_TYPES as readonly string[]).includes(device.type)
}

/** 挂牌覆盖范围：单设备 / 整个防火分区 / 整层。范围一变，依据指纹立即变化 */
export type TagScopeLevel = 'device' | 'zone' | 'floor'
export type TagScope = { level: TagScopeLevel; target: string }

export type LockoutReason = '检修挂牌' | '故障隔离' | '夜班调试'

export type LockoutTag = {
  id: string
  /** 设备锚点：分区/楼层挂牌时取该范围内首个设备，便于追溯 */
  deviceId: string
  scope: TagScope
  reason: LockoutReason
  note: string
  operator: string
  /** 生效批次号，挂牌与批次一一对应 */
  batchNo: string
  /** 生效时所依据的共用依据 */
  basisId: string
  createdAt: number
  active: boolean
  /** 写入尚未确认时占位：先到先得的占位标记，失败回滚后释放 */
  reserved?: boolean
  removedAt?: number
}

export function scopeCovers(scope: TagScope, device: Device): boolean {
  if (scope.level === 'device') return device.id === scope.target
  if (scope.level === 'zone') return device.zone === scope.target
  return device.floor === scope.target
}

export function scopeLabel(scope: TagScope, devices: Device[]): string {
  if (scope.level === 'device') return devices.find((item) => item.id === scope.target)?.name ?? scope.target
  if (scope.level === 'zone') return `分区 ${scope.target}`
  return `楼层 ${scope.target}`
}

/** 当前生效挂牌覆盖到的全部设备 */
export function coveredDeviceIds(tags: LockoutTag[], devices: Device[]): Set<string> {
  const ids = new Set<string>()
  for (const tag of tags) {
    if (!tag.active || tag.reserved) continue
    for (const device of devices) {
      if (scopeCovers(tag.scope, device)) ids.add(device.id)
    }
  }
  return ids
}

/**
 * 共用依据指纹：设备挂牌、因果规则、审阅批次都引用同一份依据。
 * 只取决于“生效中挂牌的覆盖范围”，范围一改指纹就变，依赖它的规则立即重算。
 */
export function basisFingerprint(tags: LockoutTag[], devices: Device[]): string {
  // 依据只取决于“生效中挂牌覆盖到的设备集合”：
  // 同范围不同写法得到同一依据；范围一改指纹立即变化，依赖它的规则立即失效重算。
  const covered = [...coveredDeviceIds(tags, devices)].sort().join(',')
  return `covers=[${covered}]`
}

export type Basis = { id: string; seq: number; fingerprint: string }

export function formatBasisId(seq: number): string {
  return `BASIS-${String(seq).padStart(4, '0')}`
}

export type RuleEvaluation = {
  ruleId: string
  /** 规则是否真正满足：启用 AND 触发侧未挂牌 AND（疏散动作 OR 动作侧未挂牌） */
  effective: boolean
  enabled: boolean
  blocked: boolean
  blockReason: string | null
  evacuation: boolean
  /** 实际执行优先级：疏散动作按已签（基线锁定时快照）优先级 */
  priority: 1 | 2 | 3
  basisId: string
}

export type EvaluationContext = {
  devices: Device[]
  tagged: Set<string>
  signedPriority: Record<string, 1 | 2 | 3>
  basisId: string
}

export function evaluateRule(rule: Rule, ctx: EvaluationContext): RuleEvaluation {
  const action = ctx.devices.find((device) => device.id === rule.actionId)
  const evacuation = isEvacuationDevice(action)
  const priority = ctx.signedPriority[rule.id] ?? rule.priority
  const base = { ruleId: rule.id, enabled: rule.enabled, evacuation, priority, basisId: ctx.basisId }

  if (!rule.enabled) return { ...base, effective: false, blocked: false, blockReason: null }
  if (ctx.tagged.has(rule.triggerId)) {
    return { ...base, effective: false, blocked: true, blockReason: '触发点位挂牌检修中，报警源被隔离' }
  }
  if (ctx.tagged.has(rule.actionId) && !evacuation) {
    return { ...base, effective: false, blocked: true, blockReason: `动作设备${action?.name ?? rule.actionId}挂牌检修中，动作不满足` }
  }
  return { ...base, effective: true, blocked: false, blockReason: null }
}

/** 疏散动作队列：挂牌范围变化不阻断疏散，始终按已签优先级（再按延时）继续 */
export function evacuationQueue(rules: Rule[], ctx: EvaluationContext): Array<RuleEvaluation & { rule: Rule }> {
  return rules
    .map((rule) => ({ rule, eval: evaluateRule(rule, ctx) }))
    .filter((item) => item.eval.evacuation && item.eval.enabled && !ctx.tagged.has(item.rule.triggerId))
    .sort((a, b) => a.eval.priority - b.eval.priority || a.rule.delay - b.rule.delay || a.rule.id.localeCompare(b.rule.id))
    .map((item) => ({ ...item.eval, rule: item.rule }))
}

/** 两名调试员同时挂同一挂牌：返回先到且仍占位/生效的冲突挂牌 */
export function findConflictingTag(
  tags: LockoutTag[],
  scope: TagScope,
  devices: Device[],
): LockoutTag | undefined {
  const candidates = devices.filter((device) => scopeCovers(scope, device))
  return tags.find((tag) => {
    // 仅“写入中占位”或“生效中”的挂牌参与冲突；已摘除（含 reserved=false 的历史记录）不参与
    const holding = tag.reserved === true || tag.active
    if (!holding) return false
    const held = devices.filter((device) => scopeCovers(tag.scope, device))
    return held.some((device) => candidates.some((candidate) => candidate.id === device.id))
  })
}

export type BatchOp = '挂牌' | '摘牌'
export type BatchStatus = '已生效' | '冲突未生效' | '写入失败待续作' | '已撤销'

export type ReviewBatch = {
  batchNo: string
  op: BatchOp
  scope: TagScope
  reason: LockoutReason
  /** 后到者保留的说明 */
  note: string
  operator: string
  createdAt: number
  /** 提交时所依据的共用依据版本 */
  basisId: string
  status: BatchStatus
  /** 冲突依据：先到批次号、先到批次依据、冲突覆盖说明 */
  conflictWith?: string
  conflictBasisId?: string
  conflictDetail?: string
  tagId?: string
  failStep?: string
  attempts: number
}

export type BatchInput = {
  op: BatchOp
  scope: TagScope
  reason: LockoutReason
  note: string
  operator: string
}

export function formatBatchNo(now: Date, seq: number): string {
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `B-${y}${m}${d}-${String(seq).padStart(3, '0')}`
}

export function formatTagId(now: Date, seq: number): string {
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `TAG-${y}${m}${d}-${String(seq).padStart(3, '0')}`
}

/** 登记一个批次（不含写入副作用），冲突时后到批次保留说明与冲突依据 */
export function planBatch(input: BatchInput & { batchNo: string; basisId: string; createdAt: number }): ReviewBatch {
  return {
    batchNo: input.batchNo,
    op: input.op,
    scope: input.scope,
    reason: input.reason,
    note: input.note,
    operator: input.operator,
    createdAt: input.createdAt,
    basisId: input.basisId,
    status: '写入失败待续作',
    attempts: 0,
  }
}

export function conflictBatch(
  batch: ReviewBatch,
  winner: LockoutTag,
  winnerBatch: ReviewBatch | undefined,
  devices: Device[],
): ReviewBatch {
  const overlap = devices
    .filter((device) => scopeCovers(batch.scope, device) && scopeCovers(winner.scope, device))
    .map((device) => device.name)
    .join('、')
  return {
    ...batch,
    status: '冲突未生效',
    conflictWith: winner.batchNo,
    conflictBasisId: winnerBatch?.basisId ?? winner.basisId,
    conflictDetail: `与先到批次 ${winner.batchNo}（${winner.operator}）覆盖范围重叠：${overlap}；先到批次依据 ${winnerBatch?.basisId ?? winner.basisId}，本批次保留不覆盖`,
  }
}

/** 报警 / 复电回传记录 */
export type CallbackEvent = '报警' | '复电'
export type CallbackStatus = '待确认' | '已确认'
export type AlarmCallback = {
  id: string
  deviceId: string
  event: CallbackEvent
  receivedAt: number
  lastReceivedAt: number
  /** 回传所属写入批次，写入失败后凭批次号续作 */
  batchNo?: string
  status: CallbackStatus
  confirmedAt?: number
  /** 重复回传次数（同一设备同一事件只算一条） */
  duplicates: number
  note?: string
}

/**
 * 接收回传：同一设备同一事件重复到达时只累加重复次数。
 * 幂等红线：已确认的结果永远不会被重复回传改回待确认。
 */
export function ingestCallback(
  records: AlarmCallback[],
  input: { id: string; deviceId: string; event: CallbackEvent; at: number; batchNo?: string; note?: string },
): { record: AlarmCallback; duplicate: boolean } {
  const existing = records.find((item) => item.deviceId === input.deviceId && item.event === input.event)
  if (existing) {
    return {
      duplicate: true,
      record: {
        ...existing,
        lastReceivedAt: input.at,
        duplicates: existing.duplicates + 1,
        // status 原样保留：已确认不回退为待确认
        status: existing.status,
        confirmedAt: existing.confirmedAt,
        batchNo: existing.batchNo ?? input.batchNo,
        note: input.note ?? existing.note,
      },
    }
  }
  return {
    duplicate: false,
    record: {
      id: input.id,
      deviceId: input.deviceId,
      event: input.event,
      receivedAt: input.at,
      lastReceivedAt: input.at,
      batchNo: input.batchNo,
      status: '待确认',
      duplicates: 0,
      note: input.note,
    },
  }
}

/** 确认只允许 待确认 → 已确认 单向流转，重复确认保持已确认 */
export function confirmCallback(record: AlarmCallback, at: number): AlarmCallback {
  if (record.status === '已确认') return record
  return { ...record, status: '已确认', confirmedAt: at }
}
