// Uso: pnpm hash-password 'mi clave'  → imprime el valor para AUTH_PASSWORD_HASH (base64)
import argon2 from 'argon2'

const password = process.argv[2]
if (!password) {
  console.error("Uso: pnpm hash-password 'mi clave'")
  process.exit(1)
}
const hash = await argon2.hash(password, { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 4 })
console.log(Buffer.from(hash, 'utf8').toString('base64'))
