import type { EntryRow } from '../data/types'

/**
 * 清洁验证的共享判定实现：提交入口与判定入口共用这一条，不再各写一套校验。
 *
 * 业务口径（先按业务定死，后续要改只动这个文件）：
 * - 提交口径 = 完整性校验：验证编号不重复、清洁规程/残留限度/取样点填全、验证人已签字。
 * - 判定口径 = 提交口径 + 精度校验：残留限度与检测结果都要可量化，且结果读数精度不粗于限度。
 * - 两处结论不一致时以判定口径为准：判定是最后一道闸，且是提交口径的超集，
 *   取样点与残留限度以验证组核定后落在记录上的为准，验证人签字缺一不可。
 *
 * 流转约束：状态只能逐级往下走（待验证 → 验证中 → 已验证/验证失败），跳级与回退都拒收；
 * 同一份验证重复提交只算一次（幂等，不重复计入）；清洁验证按设备排期，状态与清洁规程
 * 回写到灭菌验证清单里同一台设备上，两处看到的是同一份。
 */

export const CLEANVALIDATE_KEY = 'cleanvalidate'
export const STERILIZE_KEY = 'sterilize'

const ENTITY = '清洁验证记录'

// 状态机：动作 → （当前状态 → 目标状态）。不在表里的组合一律拒收；已验证/验证失败是终态。
const TRANSITIONS: Record<string, Record<string, string>> = {
  提交验证: { 待验证: '验证中' },
  确认验证: { 验证中: '已验证' },
  判定失败: { 验证中: '验证失败' },
}

// 动作归口：提交入口只跑提交口径，判定类入口（确认通过/判定失败）跑判定口径。
const ACTION_ENTRY: Record<string, 'submit' | 'determine'> = {
  提交验证: 'submit',
  确认验证: 'determine',
  判定失败: 'determine',
}

// 完整性：这些字段必须填全（验证人签字、取样点与残留限度由验证组核定后落在记录上）。
const REQUIRED_FIELDS = ['验证编号', '清洁规程', '残留限度', '取样点', '验证人']
// 判定入口额外要求：没有检测结果谈不上判定。
const DETERMINE_FIELDS = ['检测结果']

const TERMINAL_STATUSES = ['已验证', '验证失败']

export type CleanValidationOutcome = {
  ok: boolean
  message: string
  /** 有变化才返回，调用方据此落库；幂等命中时不给，避免重复写入。 */
  rows?: EntryRow[]
  /** 需要回写到灭菌验证清单的行（按设备匹配，无变化不给）。 */
  sterilizeRows?: EntryRow[]
}

function text(value: unknown): string {
  return String(value ?? '').trim()
}

function checkCompleteness(row: EntryRow, rows: EntryRow[]): string[] {
  const problems: string[] = []
  for (const field of REQUIRED_FIELDS) {
    if (text(row[field]) === '') {
      problems.push(`${field}未填`)
    }
  }
  const code = text(row['验证编号'])
  if (code !== '') {
    const duplicated = rows.some(
      (other) => Number(other.id) !== Number(row.id) && text(other['验证编号']) === code,
    )
    if (duplicated) {
      problems.push(`验证编号「${code}」与其他记录重复，同一份验证只算一次`)
    }
  }
  return problems
}

// 量化表述：数值开头，可带小数与单位（如 "10 ppm"、"0.05 μg/cm²"）。
const QUANTITY_PATTERN = /^\s*(-?\d+(?:\.(\d+))?)/

function parseQuantity(raw: unknown): { value: number; decimals: number } | null {
  const match = QUANTITY_PATTERN.exec(text(raw))
  if (!match) {
    return null
  }
  return { value: Number(match[1]), decimals: match[2]?.length ?? 0 }
}

// 清洁规程精度：限度与结果都要可量化，且检测结果的读数精度不能粗于残留限度，否则退回校准。
function checkPrecision(row: EntryRow): string[] {
  const problems: string[] = []
  const limit = parseQuantity(row['残留限度'])
  const result = parseQuantity(row['检测结果'])
  if (text(row['残留限度']) !== '' && !limit) {
    problems.push('残留限度不是量化表述')
  }
  if (text(row['检测结果']) !== '' && !result) {
    problems.push('检测结果不是量化表述')
  }
  if (limit && result && result.decimals < limit.decimals) {
    problems.push(
      `检测结果精度（${result.decimals} 位小数）低于残留限度（${limit.decimals} 位小数）`,
    )
  }
  return problems
}

/** 两个入口共用的同一条校验：提交跑完整性，判定在完整性上加精度。 */
export function validateCleanValidation(
  row: EntryRow,
  rows: EntryRow[],
  entry: 'submit' | 'determine',
): string[] {
  const problems = checkCompleteness(row, rows)
  if (entry === 'determine') {
    for (const field of DETERMINE_FIELDS) {
      if (text(row[field]) === '') {
        problems.push(`${field}未填`)
      }
    }
    const precisionProblems = checkPrecision(row)
    if (precisionProblems.length > 0) {
      problems.push(`清洁规程精度不够，退回校准（${precisionProblems.join('；')}）`)
    }
  }
  return problems
}

// 状态回写：清洁验证按设备排期，灭菌验证清单里同一台设备要能看见清洁验证状态与清洁规程。
// 以清洁验证记录为唯一来源，值不一致才更新，重复回写是幂等的。
function syncSterilizeRows(sterilizeRows: EntryRow[], cleanRow: EntryRow): EntryRow[] | undefined {
  const equipment = text(cleanRow['设备名称'])
  if (equipment === '') {
    return undefined
  }
  let changed = false
  const next = sterilizeRows.map((item) => {
    if (text(item['灭菌设备']) !== equipment) {
      return item
    }
    if (
      text(item['清洁验证状态']) === text(cleanRow.status) &&
      text(item['清洁规程']) === text(cleanRow['清洁规程'])
    ) {
      return item
    }
    changed = true
    return { ...item, 清洁验证状态: cleanRow.status, 清洁规程: cleanRow['清洁规程'] }
  })
  return changed ? next : undefined
}

/**
 * 清洁验证动作的唯一入口：状态机 + 共享校验 + 幂等 + 回写，都在这一条里。
 * 纯函数，不碰存储；调用方（local-service）负责落库。
 */
export function applyCleanValidationAction(
  rows: EntryRow[],
  sterilizeRows: EntryRow[],
  id: number,
  action: string,
): CleanValidationOutcome {
  const transitions = TRANSITIONS[action]
  if (!transitions) {
    return { ok: false, message: `${ENTITY}没有登记「${action}」这个动作` }
  }
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${ENTITY}` }
  }
  const row = rows[index]
  const current = text(row.status)
  const target = transitions[current]

  // 同一份验证重复提交只算一次：已处于本动作的目标态，幂等返回，不重复计入、不重复回写。
  if (!target && Object.values(transitions).includes(current)) {
    return {
      ok: true,
      message: `${ENTITY}已处于「${current}」，重复${action}只算一次`,
      sterilizeRows: syncSterilizeRows(sterilizeRows, row),
    }
  }
  // 状态只能逐级往下流转，跳级与回退都拒收。
  if (!target) {
    return {
      ok: false,
      message: `状态只能逐级往下流转，跳级与回退都拒收：当前「${current}」不允许执行「${action}」`,
    }
  }

  const problems = validateCleanValidation(row, rows, ACTION_ENTRY[action])
  if (problems.length > 0) {
    return { ok: false, message: `${ENTITY}未通过${action}校验：${problems.join('；')}` }
  }

  const updated: EntryRow = {
    ...row,
    status: target,
    pending: !TERMINAL_STATUSES.includes(target),
    abnormal: target === '验证失败',
  }
  const next = [...rows]
  next[index] = updated
  return {
    ok: true,
    message: `${ENTITY}已${action}，当前状态「${target}」`,
    rows: next,
    sterilizeRows: syncSterilizeRows(sterilizeRows, updated),
  }
}
