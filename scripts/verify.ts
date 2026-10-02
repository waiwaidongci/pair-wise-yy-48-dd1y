import assert from 'node:assert/strict'
import {
  basisFingerprint,
  confirmCallback,
  conflictBatch,
  coveredDeviceIds,
  evaluateRule,
  evacuationQueue,
  findConflictingTag,
  formatBatchNo,
  ingestCallback,
  planBatch,
  scopeCovers,
  type LockoutTag,
  type TagScope,
} from '../src/linkage/domain'
import { seedDevices, seedRules, type Device, type Rule } from '../src/stores/linkage'

const devices: Device[] = structuredClone(seedDevices)
const rules: Rule[] = structuredClone(seedRules)
const byId = (id: string) => devices.find((d) => d.id === id)!
const ruleById = (id: string) => rules.find((r) => r.id === id)!

let passed = 0
function check(name: string, fn: () => void) {
  fn()
  passed += 1
  console.log(`  ✓ ${name}`)
}

function activeTag(scope: TagScope, batchNo: string, basisId = 'BASIS-0001', createdAt = 1): LockoutTag {
  return {
    id: `TAG-${batchNo}`,
    deviceId: devices.find((d) => scopeCovers(scope, d))?.id ?? '',
    scope,
    reason: '检修挂牌',
    note: '',
    operator: '调试员',
    batchNo,
    basisId,
    createdAt,
    active: true,
  }
}

// 场景 1：矩阵不能只看启停——动作设备挂牌后规则立即不满足
console.log('\n[1] 挂牌覆盖与规则立即失效重算（共用依据）')
const rollerScope: TagScope = { level: 'device', target: 'A-01-02' }
const noTagsCtx = { devices, tagged: new Set<string>(), signedPriority: {}, basisId: 'BASIS-0001' }
check('无挂牌时 R-003（卷帘动作）满足', () => {
  assert.equal(evaluateRule(ruleById('R-003'), noTagsCtx).effective, true)
})
const tagged = coveredDeviceIds([activeTag(rollerScope, 'B-1')], devices)
const fpBefore = basisFingerprint([], devices)
const fpAfter = basisFingerprint([activeTag(rollerScope, 'B-1')], devices)
check('挂牌后依据指纹变化（BASIS 推进）', () => {
  assert.notEqual(fpBefore, fpAfter)
  assert.ok(tagged.has('A-01-02'))
})
const taggedCtx = { devices, tagged, signedPriority: {}, basisId: 'BASIS-0002' }
check('挂牌后 R-003 即使 enabled=true 也判为未满足并给出阻断原因', () => {
  const result = evaluateRule(ruleById('R-003'), taggedCtx)
  assert.equal(result.enabled, true)
  assert.equal(result.effective, false)
  assert.equal(result.blocked, true)
  assert.match(result.blockReason ?? '', /挂牌/)
  assert.equal(result.basisId, 'BASIS-0002')
})
check('摘牌后同一规则自动恢复满足（无需改矩阵）', () => {
  assert.equal(evaluateRule(ruleById('R-003'), noTagsCtx).effective, true)
})
check('触发点位挂牌同样隔离其全部规则', () => {
  const ctx = { devices, tagged: new Set(['D-01-01']), signedPriority: {}, basisId: 'BASIS-0003' }
  assert.equal(evaluateRule(ruleById('R-001'), ctx).effective, false)
  assert.match(evaluateRule(ruleById('R-001'), ctx).blockReason ?? '', /报警源/)
})

// 场景 2：疏散动作按已签优先级继续
console.log('\n[2] 疏散动作挂牌不阻断，按已签优先级继续')
const evacDevice = byId('A-01-01') // 一层排烟风机 PF-1（疏散设备）
check('排烟风机被识别为疏散设备', () => {
  assert.ok(['排烟风机', '消防广播', '电梯'].includes(evacDevice.type))
})
const evacCtx = { devices, tagged: new Set(['A-01-01', 'A-01-03']), signedPriority: { 'R-001': 1, 'R-004': 1, 'R-002': 2 }, basisId: 'BASIS-0004' }
check('动作侧挂牌时疏散规则仍满足、非疏散规则不满足', () => {
  assert.equal(evaluateRule(ruleById('R-001'), evacCtx).effective, true)
  assert.equal(evaluateRule(ruleById('R-003'), { ...evacCtx, tagged: new Set(['A-01-02']) }).effective, false)
})
check('疏散队列按已签优先级（再按延时、规则号）排序，不被挂牌打乱', () => {
  const queue = evacuationQueue(rules, evacCtx).map((item) => item.ruleId)
  // 已签 P1 的 R-001（延时0）在前；未签名的疏散规则按自身 priority、延时、规则号排序；
  // R-002 已签 P2 排到 P1 组之后；动作侧挂牌的 PF-1/广播仍在队列中
  assert.equal(queue[0], 'R-001')
  assert.ok(queue.includes('R-002'))
  assert.ok(queue.includes('R-005') && queue.includes('R-006') && queue.includes('R-008'))
  assert.ok(queue.indexOf('R-001') < queue.indexOf('R-002'))
  assert.ok(queue.indexOf('R-005') < queue.indexOf('R-006')) // P1 先于 P2
})
check('已签优先级覆盖规则当前 priority（锁定后改矩阵不改变疏散顺序）', () => {
  const result = evaluateRule(ruleById('R-002'), evacCtx)
  assert.equal(result.priority, 2)
})

// 场景 3：两名调试员同时挂同一挂牌——先到生效，后到保留说明与冲突依据
console.log('\n[3] 并发同挂牌：先到先得，后到保留说明与冲突依据')
const scope: TagScope = { level: 'device', target: 'A-01-01' }
const winnerTag = activeTag(scope, 'B-20261002-010', 'BASIS-0005')
check('先到批次占位/生效后，同范围提交检测到冲突', () => {
  const conflict = findConflictingTag([winnerTag], scope, devices)
  assert.equal(conflict?.batchNo, 'B-20261002-010')
})
const winnerBatch = planBatch({ op: '挂牌', scope, reason: '检修挂牌', note: '先到说明', operator: '调试员甲', batchNo: 'B-20261002-010', basisId: 'BASIS-0005', createdAt: 1 })
winnerBatch.status = '已生效'
const loserBatch = planBatch({ op: '挂牌', scope, reason: '夜班调试', note: '后到调试员的检修说明必须保留', operator: '调试员乙', batchNo: 'B-20261002-011', basisId: 'BASIS-0005', createdAt: 2 })
const resolved = conflictBatch(loserBatch, winnerTag, winnerBatch, devices)
check('后到批次状态为冲突未生效，不覆盖先到挂牌', () => {
  assert.equal(resolved.status, '冲突未生效')
  assert.equal(resolved.conflictWith, 'B-20261002-010')
  assert.equal(resolved.conflictBasisId, 'BASIS-0005')
})
check('后到批次的说明和冲突依据完整保留', () => {
  assert.equal(resolved.note, '后到调试员的检修说明必须保留')
  assert.match(resolved.conflictDetail ?? '', /B-20261002-010/)
})
check('分区挂牌与设备挂牌范围重叠也判冲突', () => {
  const zoneTag = activeTag({ level: 'zone', target: 'A 区' }, 'B-20261002-012', 'BASIS-0006')
  const conflict = findConflictingTag([zoneTag], { level: 'device', target: 'A-01-01' }, devices)
  assert.equal(conflict?.batchNo, 'B-20261002-012')
})
check('先到挂牌摘除后，同范围不再冲突（可按原批次号续作）', () => {
  const removed = { ...winnerTag, active: false, removedAt: 9 }
  assert.equal(findConflictingTag([removed], scope, devices), undefined)
})
check('批次号按日期+序号生成，续作沿用原号不重新发号', () => {
  assert.equal(formatBatchNo(new Date('2026-10-02T03:12:00'), 7), 'B-20261002-007')
})

// 场景 4：写入失败后按批次号续作（store 级，真实走控制器写入）
console.log('\n[4] 写入失败后按批次号续作（store + 控制器通道）')
const { useLinkageStore } = await import('../src/stores/linkage')
const { setActivePinia, createPinia } = await import('pinia')
setActivePinia(createPinia())
const store = useLinkageStore()
store.tags.splice(0, store.tags.length)
store.batches.splice(0, store.batches.length)
store.callbacks.splice(0)
const basisStart = store.basisId
store.armFailure('controller:lockout')
const failed = await store.submitLockoutBatch({ op: '挂牌', scope: { level: 'device', target: 'A-01-01' }, reason: '检修挂牌', note: '夜班写入中断演练', operator: '调试员甲' })
check('首个写入步骤失败：批次保留为待续作并记录失败步骤', () => {
  assert.equal(failed.status, '写入失败待续作')
  assert.equal(failed.failStep, 'controller:lockout')
  assert.equal(store.activeTags.length, 0)
})
check('失败不推进依据，规则仍按原依据满足', () => {
  assert.equal(store.basisId, basisStart)
  assert.equal(store.evaluationOf('R-001')?.effective, true)
})
const resumed = await store.resumeBatch(failed.batchNo)
check('按原批次号续作成功：不重新发号、从失败步骤继续、挂牌生效', () => {
  assert.equal(resumed.batchNo, failed.batchNo)
  assert.equal(resumed.status, '已生效')
  assert.equal(resumed.attempts, 2)
  assert.equal(store.activeTags.length, 1)
})
check('续作生效后依据推进，依赖规则立即重算失效', () => {
  assert.notEqual(store.basisId, basisStart)
  assert.equal(store.evaluationOf('R-001')?.effective, true) // PF-1 是疏散设备，动作侧挂牌仍执行
})

// 场景 4b：后到冲突批次在依据变化（先到者摘牌）后可按原批次号续作
const loser = await store.submitLockoutBatch({ op: '挂牌', scope: { level: 'device', target: 'A-01-01' }, reason: '夜班调试', note: '调试员乙的保留说明', operator: '调试员乙' })
check('同范围第二次提交：冲突未生效且保留先到批次依据', () => {
  assert.equal(loser.status, '冲突未生效')
  assert.equal(loser.conflictWith, failed.batchNo)
  assert.equal(loser.note, '调试员乙的保留说明')
})
await store.submitReleaseBatch(store.activeTags[0].id, { note: '复电摘牌', operator: '调试员甲' })
const loserResumed = await store.resumeBatch(loser.batchNo)
check('依据推进后后到批次按原号续作生效', () => {
  assert.equal(loserResumed.batchNo, loser.batchNo)
  assert.equal(loserResumed.status, '已生效')
  assert.equal(store.activeTags[0].note, '调试员乙的保留说明')
})

// 场景 4b-1：先到批次写入失败释放占位，后到登记冲突；先到续作生效后后到仍不可续作
store.armFailure('controller:lockout')
const failedFirst = await store.submitLockoutBatch({ op: '挂牌', scope: { level: 'device', target: 'A-01-03' }, reason: '夜班调试', note: '先到但写入失败', operator: '调试员甲' })
const secondWhileFailed = await store.submitLockoutBatch({ op: '挂牌', scope: { level: 'device', target: 'A-01-03' }, reason: '夜班调试', note: '后到说明保留', operator: '调试员乙' })
check('先到写入失败期间，后到仍登记为冲突并保留说明', () => {
  assert.equal(failedFirst.status, '写入失败待续作')
  assert.equal(secondWhileFailed.status, '冲突未生效')
  assert.equal(secondWhileFailed.conflictWith, failedFirst.batchNo)
  assert.equal(secondWhileFailed.note, '后到说明保留')
})
const firstResumed = await store.resumeBatch(failedFirst.batchNo)
check('先到批次续作生效后后到批次仍冲突，不可续作', () => {
  assert.equal(firstResumed.status, '已生效')
  assert.equal(store.canResumeConflict(secondWhileFailed.batchNo), false)
})
await store.submitReleaseBatch(store.activeTags.find((t) => t.batchNo === firstResumed.batchNo)!.id, { note: '复电', operator: '调试员甲' })
check('先到摘牌、冲突依据失效后，后到批次可按原号续作', () => {
  assert.equal(store.canResumeConflict(secondWhileFailed.batchNo), true)
})

// 场景 5：重复回传幂等，不能把已确认改回待确认
console.log('\n[5] 报警/复电回传幂等')
let records: ReturnType<typeof ingestCallback>['record'][] = []
const first = ingestCallback(records, { id: 'CB-0001', deviceId: 'D-01-01', event: '报警', at: 100 })
records.push(first.record)
check('首次回传为待确认', () => {
  assert.equal(first.duplicate, false)
  assert.equal(records[0].status, '待确认')
})
records[0] = confirmCallback(records[0], 150)
check('确认后变为已确认', () => assert.equal(records[0].status, '已确认'))
const dup = ingestCallback(records, { id: 'CB-0002', deviceId: 'D-01-01', event: '报警', at: 200 })
records[0] = dup.record
check('重复回传只累加次数，已确认不回退待确认', () => {
  assert.equal(dup.duplicate, true)
  assert.equal(records[0].status, '已确认')
  assert.equal(records[0].confirmedAt, 150)
  assert.equal(records[0].duplicates, 1)
})
const dup2 = ingestCallback(records, { id: 'CB-0003', deviceId: 'D-01-01', event: '报警', at: 300 })
records[0] = dup2.record
check('第三次回传仍然幂等', () => {
  assert.equal(records[0].status, '已确认')
  assert.equal(records[0].duplicates, 2)
})
check('复电与报警分别建记录；重复确认保持已确认', () => {
  const restore = ingestCallback(records, { id: 'CB-0004', deviceId: 'D-01-01', event: '复电', at: 400 })
  assert.equal(restore.duplicate, false)
  assert.equal(restore.record.status, '待确认')
  assert.equal(confirmCallback(restore.record, 450).status, '已确认')
  assert.equal(confirmCallback(confirmCallback(restore.record, 450), 500).status, '已确认')
})

// store 级回传幂等 + 复电关联失败批次续作
console.log('\n[6] store 级回传：重复不改状态，复电回传关联批次可续作')
store.armFailure('controller:release')
const tagForRelease = store.activeTags[0]
const release = await store.submitReleaseBatch(tagForRelease.id, { note: '复电', operator: '调试员乙' })
check('摘牌写入失败形成待续作批次', () => assert.equal(release.status, '写入失败待续作'))
const cb1 = store.receiveCallback({ deviceId: 'D-01-01', event: '报警' })
store.acknowledgeCallback(cb1.record.id)
const cb2 = store.receiveCallback({ deviceId: 'D-01-01', event: '报警' })
check('store 中重复报警不把已确认改回待确认', () => {
  assert.equal(cb2.duplicate, true)
  assert.equal(store.callbacks[0].status, '已确认')
  assert.equal(store.callbacks[0].duplicates, 1)
})
const restoreCb = store.receiveCallback({ deviceId: 'A-01-01', event: '复电', batchNo: release.batchNo })
const restoredBatch = await store.resumeBatchFromCallback(restoreCb.record.id)
check('复电回传携带批次号，按批次号续作完成摘牌', () => {
  assert.equal(restoredBatch?.batchNo, release.batchNo)
  assert.equal(restoredBatch?.status, '已撤销')
  assert.equal(store.activeTags.length, 0)
})

console.log(`\n全部 ${passed} 项检查通过 ✅`)
