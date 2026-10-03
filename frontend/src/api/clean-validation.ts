import type { ActionResult, EntryRow } from '@/data/types'

// 清洁验证的提交与判定共用这一份实现。
// 历史上「提交验证」和「判定失败」各写了一套校验（验证编号查重、清洁规程与残留限度
// 是否填全、取样点齐不齐），两套同时跑，时间一长结论对不上。现在两个入口都走
// runCleanValidationAction，只有这一条实现。
//
// 口径按业务定为「判定口径为准」：提交是判定的前置登记，跑同一份校验的登记段；
// 判定（确认验证 / 判定失败）跑全量，多验的两项——检测结果、验证人签字——在验证
// 执行前客观上还不存在，这是两个入口唯一的出入。

export type CleanValidationResult = ActionResult & {
  // 有变化才返回，调用方据此决定要不要落库；重复提交幂等时两个都不给。
  cleanRows?: EntryRow[]
  sterilizeRows?: EntryRow[]
}

// 状态只能往下流转：待验证 → 验证中 → 已验证 / 验证失败。
// 每个动作登记了唯一来源状态，不在来源状态上执行就是跳级或回退，一律拒收。
const STATUS_ORDER = ['待验证', '验证中', '已验证', '验证失败']
const TERMINAL_STATUSES = ['已验证', '验证失败']

const TRANSITIONS: Record<string, { from: string; to: string }> = {
  提交验证: { from: '待验证', to: '验证中' },
  确认验证: { from: '验证中', to: '已验证' },
  判定失败: { from: '验证中', to: '验证失败' },
}

// 提交时留档清洁规程的字段名：判定时拿来比对，两处看到的必须对得上。
// 不在模块字段表里，列表和导出都不展示；老数据没有这个字段就跳过比对，不回刷。
const SNAPSHOT_FIELD = '提交时清洁规程'

// 规程与限度里必须出现数值参数（浓度、温度、限度值……），否则视为精度不够，退回校准。
const NUMERIC_PARAMETER = /\d+(?:\.\d+)?/

function text(value: unknown): string {
  return String(value ?? '').trim()
}

type Phase = 'submit' | 'judge'

// 两个入口共用的校验：返回 null 表示通过，否则返回拒收原因。
function checkCleanValidation(row: EntryRow, rows: EntryRow[], phase: Phase): string | null {
  // 清洁验证按设备排期，设备名称是排期键，也是回写灭菌清单的对照键。
  if (!text(row['设备名称'])) {
    return '清洁验证按设备排期，设备名称不能为空'
  }
  const code = text(row['验证编号'])
  if (!code) {
    return '验证编号不能为空'
  }
  const duplicated = rows.some(
    (item) => Number(item.id) !== Number(row.id) && text(item['验证编号']) === code,
  )
  if (duplicated) {
    return `验证编号 ${code} 已存在，同一份验证只算一次`
  }
  if (!text(row['清洁规程'])) {
    return '清洁规程未填写'
  }
  if (!text(row['残留限度'])) {
    return '残留限度未填写，需验证组核定后补全'
  }
  if (!text(row['取样点'])) {
    return '取样点不齐全，需验证组核定后补全'
  }
  if (!NUMERIC_PARAMETER.test(text(row['清洁规程']))) {
    return '清洁规程精度不够（缺少数值参数），退回校准'
  }
  if (!NUMERIC_PARAMETER.test(text(row['残留限度']))) {
    return '残留限度精度不够（缺少数值参数），退回校准'
  }
  if (phase === 'judge') {
    if (!text(row['检测结果'])) {
      return '检测结果未填写，不能判定'
    }
    if (!text(row['验证人'])) {
      return '验证人未签字，不能判定'
    }
    const submitted = text(row[SNAPSHOT_FIELD])
    if (submitted && submitted !== text(row['清洁规程'])) {
      return '清洁规程与提交时不一致，两处看到的对不上'
    }
  }
  return null
}

export function runCleanValidationAction(
  cleanRows: EntryRow[],
  sterilizeRows: EntryRow[],
  id: number,
  action: string,
): CleanValidationResult {
  const transition = TRANSITIONS[action]
  if (!transition) {
    return { ok: false, message: `清洁验证记录没有登记「${action}」这个动作` }
  }
  const index = cleanRows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的清洁验证记录` }
  }
  const row = cleanRows[index]
  const current = text(row.status)

  // 同一份验证重复提交只算一次：已提交的直接放行，不改状态、不重复留档。
  if (action === '提交验证' && current === '验证中') {
    return { ok: true, message: '该验证已提交过，重复提交只算一次' }
  }
  if (TERMINAL_STATUSES.includes(current)) {
    return { ok: false, message: `「${current}」已是终态，状态不能再流转` }
  }
  if (current !== transition.from) {
    const currentStep = STATUS_ORDER.indexOf(current)
    const fromStep = STATUS_ORDER.indexOf(transition.from)
    if (currentStep > fromStep) {
      return { ok: false, message: `状态只能往下流转：当前「${current}」不能回退执行「${action}」` }
    }
    return {
      ok: false,
      message: `状态只能逐级流转：「${action}」要求当前为「${transition.from}」，跳级拒收`,
    }
  }

  const phase: Phase = action === '提交验证' ? 'submit' : 'judge'
  const problem = checkCleanValidation(row, cleanRows, phase)
  if (problem) {
    return { ok: false, message: problem }
  }

  const updated: EntryRow = {
    ...row,
    status: transition.to,
    pending: transition.to === '验证中',
    abnormal: transition.to === '验证失败',
  }
  if (action === '提交验证') {
    updated[SNAPSHOT_FIELD] = text(row['清洁规程'])
  }
  const nextCleanRows = [...cleanRows]
  nextCleanRows[index] = updated

  // 状态回写到灭菌验证的清单：同一台设备（按设备排期）的灭菌记录同步看到清洁验证状态。
  // 只写业务字段「验证状态」，不动灭菌验证自己的流转状态。
  const device = text(updated['设备名称'])
  let sterilizeChanged = false
  const nextSterilizeRows = sterilizeRows.map((item) => {
    if (text(item['灭菌设备']) !== device) {
      return item
    }
    sterilizeChanged = true
    return { ...item, 验证状态: `清洁验证：${transition.to}` }
  })

  return {
    ok: true,
    message: `清洁验证记录已${action}，当前状态「${transition.to}」`,
    cleanRows: nextCleanRows,
    sterilizeRows: sterilizeChanged ? nextSterilizeRows : undefined,
  }
}
