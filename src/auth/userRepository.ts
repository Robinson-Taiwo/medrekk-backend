import type { Role } from '../shared/auth.js'
import type { CredentialStatus } from '../shared/types.js'

export interface User {
  id: string
  email: string
  passwordHash: string
  fullName: string
  role: Role
  patientId: string | null
  facility: string | null
  credentialStatus: CredentialStatus | null
  phone?: string
  /** bcrypt hash of the 4-digit USSD PIN. Unset means USSD is off for this account. */
  ussdPinHash?: string
  /** Consecutive wrong PINs. Reset on a correct one. */
  ussdPinFailures?: number
  /** ISO timestamp until which USSD is refused for this account. */
  ussdLockedUntil?: string
  createdAt: string
}

export interface UserRepository {
  findByEmail(email: string): Promise<User | null>
  findByPhone(phone: string): Promise<User | null>
  findById(id: string): Promise<User | null>
  create(user: User): Promise<void>
  update(user: User): Promise<void>
  listByRole(role: Role): Promise<User[]>
}

export class InMemoryUserRepository implements UserRepository {
  private readonly byId = new Map<string, User>()
  private readonly idByEmail = new Map<string, string>()
  private readonly idByPhone = new Map<string, string>()

  async findByEmail(email: string): Promise<User | null> {
    const id = this.idByEmail.get(email)
    return id ? (this.byId.get(id) ?? null) : null
  }

  async findByPhone(phone: string): Promise<User | null> {
    const id = this.idByPhone.get(phone)
    return id ? (this.byId.get(id) ?? null) : null
  }

  async findById(id: string): Promise<User | null> {
    return this.byId.get(id) ?? null
  }

  async create(user: User): Promise<void> {
    this.byId.set(user.id, user)
    this.idByEmail.set(user.email, user.id)
    if (user.phone) this.idByPhone.set(user.phone, user.id)
  }

  async update(user: User): Promise<void> {
    // The phone index has to follow the record, or a changed number becomes unfindable
    // and USSD stops recognising the account.
    const previous = this.byId.get(user.id)
    if (previous?.phone && previous.phone !== user.phone) this.idByPhone.delete(previous.phone)
    if (previous && previous.email !== user.email) this.idByEmail.delete(previous.email)
    this.byId.set(user.id, user)
    this.idByEmail.set(user.email, user.id)
    if (user.phone) this.idByPhone.set(user.phone, user.id)
  }

  async listByRole(role: Role): Promise<User[]> {
    return [...this.byId.values()].filter((u) => u.role === role)
  }
}
