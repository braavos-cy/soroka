// Password rules — mirror of backend/soroka/security.py:check_password_policy (the server is authoritative).
export const PW_MIN = 12
export const PW_MAX = 128

const COMMON = ['password', 'passw0rd', 'qwerty', 'qwertyuiop', 'asdfgh', 'zxcvbn', 'admin', 'administrator', 'welcome',
  'letmein', 'iloveyou', 'monkey', 'dragon', 'master', 'sunshine', 'football', 'abc', 'abcdef', 'secret',
  'changeme', 'default', 'soroka', 'сорока', 'пароль', 'йцукен', 'привет', 'люблю']
const COMMON_SUB = ['password', 'qwerty', 'soroka', 'сорока', 'пароль', 'йцукен']

const isLower = (c: string) => c !== c.toUpperCase() && c === c.toLowerCase()
const isUpper = (c: string) => c !== c.toLowerCase() && c === c.toUpperCase()
const isDigit = (c: string) => /\p{Nd}/u.test(c)
const isAlnum = (c: string) => /[\p{L}\p{N}]/u.test(c)

export type Rule = { key: string; ok: boolean }

/** Every rule with its pass state, in the same order the server checks them. */
export function passwordRules(pw: string, email = '', current = ''): Rule[] {
  const chars = [...pw]
  const low = pw.toLowerCase()
  const lowChars = [...low]
  const letters = lowChars.filter((c) => /\p{L}/u.test(c)).join('')
  const local = email.split('@')[0].toLowerCase()
  let repetitive = new Set(lowChars).size < 6
  for (let i = 0; i + 3 < lowChars.length; i++)
    if (lowChars[i] === lowChars[i + 1] && lowChars[i] === lowChars[i + 2] && lowChars[i] === lowChars[i + 3]) repetitive = true
  return [
    { key: 'password_too_short', ok: chars.length >= PW_MIN && chars.length <= PW_MAX },
    { key: 'password_no_lower', ok: chars.some(isLower) },
    { key: 'password_no_upper', ok: chars.some(isUpper) },
    { key: 'password_no_digit', ok: chars.some(isDigit) },
    { key: 'password_no_symbol', ok: chars.some((c) => !isAlnum(c)) },
    { key: 'password_repetitive', ok: pw !== '' && !repetitive },
    { key: 'password_common', ok: pw !== '' && !COMMON.includes(letters) && !COMMON_SUB.some((w) => low.includes(w)) },
    { key: 'password_contains_email', ok: !(local.length >= 4 && low.includes(local)) },
    { key: 'password_reused', ok: !current || pw !== current },
  ]
}

/** Random password that satisfies every rule (no look-alike characters). */
export function generatePassword(len = 20): string {
  const sets = ['abcdefghijkmnpqrstuvwxyz', 'ABCDEFGHJKLMNPQRSTUVWXYZ', '23456789', '!#$%&*+-=?@_~']
  const all = sets.join('')
  const rnd = (n: number) => { const a = new Uint32Array(1); crypto.getRandomValues(a); return a[0] % n }
  for (;;) {
    const out = sets.map((s) => s[rnd(s.length)])
    while (out.length < len) out.push(all[rnd(all.length)])
    for (let i = out.length - 1; i > 0; i--) { const j = rnd(i + 1); [out[i], out[j]] = [out[j], out[i]] }
    const pw = out.join('')
    if (passwordRules(pw).every((r) => r.ok)) return pw
  }
}
