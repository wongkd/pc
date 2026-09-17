/**
 * 把 .sql 文件拆成可逐条提交的语句。
 *
 * 为什么要自己拆：D1 的 exec() 按换行切分语句，多行 DDL 会被切坏；
 * 而触发器体内本身含分号（BEGIN ... END;），按 ';' 裸拆同样会切坏。
 * 这里做最小可用的扫描器：跳过行注释、块注释、字符串字面量，
 * 并把 CREATE TRIGGER 的 BEGIN...END 视为一条语句。
 */

export function splitSql(source) {
  const statements = []
  let current = ''
  let index = 0
  let inTrigger = false

  const push = () => {
    const trimmed = current.trim()
    if (trimmed) statements.push(trimmed)
    current = ''
    inTrigger = false
  }

  while (index < source.length) {
    const char = source[index]
    const next = source[index + 1]

    // 行注释
    if (char === '-' && next === '-') {
      while (index < source.length && source[index] !== '\n') index += 1
      continue
    }

    // 块注释
    if (char === '/' && next === '*') {
      index += 2
      while (index < source.length && !(source[index] === '*' && source[index + 1] === '/')) index += 1
      index += 2
      continue
    }

    // 字符串字面量（含 '' 转义）
    if (char === "'" || char === '"') {
      const quote = char
      current += char
      index += 1
      while (index < source.length) {
        current += source[index]
        if (source[index] === quote) {
          if (source[index + 1] === quote) {
            current += source[index + 1]
            index += 2
            continue
          }
          index += 1
          break
        }
        index += 1
      }
      continue
    }

    if (char === ';') {
      // 触发器体内的分号不结束语句，只有 END 之后的分号才算
      if (inTrigger && !/\bEND$/i.test(current.trim())) {
        current += char
        index += 1
        continue
      }
      push()
      index += 1
      continue
    }

    current += char
    index += 1

    if (!inTrigger && /^\s*CREATE\s+(TEMP\s+|TEMPORARY\s+)?TRIGGER\b/i.test(current)) {
      inTrigger = true
    }
  }

  push()
  return statements
}
