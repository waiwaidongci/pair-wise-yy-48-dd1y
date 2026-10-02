/**
 * 模拟现场控制器写入通道。
 * 挂牌/摘牌需要把动作写进控制器，夜班网络可能断连。
 * 失败点通过 localStorage 标记注入，触发一次后自动清除（只失败一次，便于续作成功）。
 */

export type WriteStep = { name: string; label: string }
export type WriteResult = { ok: true } | { ok: false; error: string; step: string }

const FAIL_ONCE_KEY = 'fire-linkage-fail-next-step'

export function armNextWriteFailure(step: string) {
  localStorage.setItem(FAIL_ONCE_KEY, step)
}

export function nextWriteFailureStep(): string | null {
  return localStorage.getItem(FAIL_ONCE_KEY)
}

export const LOCKOUT_STEPS: WriteStep[] = [
  { name: 'controller:lockout', label: '写入控制器隔离位' },
  { name: 'panel:lockout', label: '联动盘挂牌确认' },
]

export const RELEASE_STEPS: WriteStep[] = [{ name: 'controller:release', label: '写入控制器恢复位' }]

export function writeStep(batchNo: string, step: WriteStep): Promise<WriteResult> {
  return new Promise((resolve) => {
    window.setTimeout(() => {
      const armed = localStorage.getItem(FAIL_ONCE_KEY)
      if (armed === step.name) {
        localStorage.removeItem(FAIL_ONCE_KEY)
        resolve({ ok: false, error: `夜班链路超时：${step.label}（批次 ${batchNo}）未收到控制器应答`, step: step.name })
        return
      }
      resolve({ ok: true })
    }, 260)
  })
}
