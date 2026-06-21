/**
 * Contacts & Groups — stored on Walrus, keyed to the user's wallet address.
 *
 * One Walrus blob per user holds the entire UserContacts object
 * (contacts + groups + metadata).  Every mutation writes a fresh blob
 * and updates the blobId reference in the local registry.
 */

import { writeUserData, readUserData } from '../walrus/client.js'

/* ─── Types ──────────────────────────────────────────────────────────────── */

export interface Contact {
  name:         string
  address:      string
  note?:        string
  createdAt:    number
  paymentCount: number
}

export interface Group {
  name:      string
  members:   { name: string; address: string }[]
  createdAt: number
}

export interface UserContacts {
  contacts:    Contact[]
  groups:      Group[]
  lastUpdated: number
}

const WALRUS_KEY = 'contacts'

const EMPTY: UserContacts = { contacts: [], groups: [], lastUpdated: 0 }

/* ─── Low-level read/write ───────────────────────────────────────────────── */

export async function loadContacts(wallet: string): Promise<UserContacts> {
  try {
    const raw = await readUserData(wallet, WALRUS_KEY)
    if (!raw) return { ...EMPTY }
    return raw as UserContacts
  } catch {
    return { ...EMPTY }
  }
}

export async function saveContacts(wallet: string, data: UserContacts): Promise<string> {
  data.lastUpdated = Date.now()
  return writeUserData(wallet, WALRUS_KEY, data)
}

/* ─── Contact CRUD ───────────────────────────────────────────────────────── */

export async function addContact(
  wallet: string,
  name: string,
  address: string,
  note?: string,
): Promise<Contact> {
  const data = await loadContacts(wallet)

  // Replace if name already exists
  const idx = data.contacts.findIndex(c => c.name.toLowerCase() === name.toLowerCase())
  const contact: Contact = {
    name,
    address,
    note,
    createdAt:    Date.now(),
    paymentCount: idx >= 0 ? data.contacts[idx].paymentCount : 0,
  }

  if (idx >= 0) {
    data.contacts[idx] = contact
  } else {
    data.contacts.push(contact)
  }

  await saveContacts(wallet, data)
  return contact
}

export async function removeContact(wallet: string, name: string): Promise<boolean> {
  const data = await loadContacts(wallet)
  const before = data.contacts.length
  data.contacts = data.contacts.filter(c => c.name.toLowerCase() !== name.toLowerCase())
  if (data.contacts.length === before) return false
  await saveContacts(wallet, data)
  return true
}

export async function listContacts(wallet: string): Promise<Contact[]> {
  const data = await loadContacts(wallet)
  return data.contacts
}

/**
 * Resolve a contact name to a wallet address.
 * Returns null if not found.
 */
export async function lookupContact(wallet: string, name: string): Promise<string | null> {
  const data = await loadContacts(wallet)
  const match = data.contacts.find(
    c => c.name.toLowerCase() === name.toLowerCase()
  )
  return match?.address ?? null
}

/* ─── Group CRUD ─────────────────────────────────────────────────────────── */

export async function createGroup(
  wallet: string,
  groupName: string,
  members: { name: string; address: string }[],
): Promise<Group> {
  const data  = await loadContacts(wallet)
  const group: Group = { name: groupName, members, createdAt: Date.now() }

  // Replace if group name exists
  const idx = data.groups.findIndex(g => g.name.toLowerCase() === groupName.toLowerCase())
  if (idx >= 0) {
    data.groups[idx] = group
  } else {
    data.groups.push(group)
  }

  await saveContacts(wallet, data)
  return group
}

export async function addGroupMember(
  wallet: string,
  groupName: string,
  member: { name: string; address: string },
): Promise<boolean> {
  const data = await loadContacts(wallet)
  const group = data.groups.find(g => g.name.toLowerCase() === groupName.toLowerCase())
  if (!group) return false

  // Remove existing member with same name, then add
  group.members = group.members.filter(m => m.name.toLowerCase() !== member.name.toLowerCase())
  group.members.push(member)

  await saveContacts(wallet, data)
  return true
}

export async function removeGroup(wallet: string, groupName: string): Promise<boolean> {
  const data = await loadContacts(wallet)
  const before = data.groups.length
  data.groups = data.groups.filter(g => g.name.toLowerCase() !== groupName.toLowerCase())
  if (data.groups.length === before) return false
  await saveContacts(wallet, data)
  return true
}

export async function removeGroupMember(
  wallet: string,
  groupName: string,
  memberName: string,
): Promise<boolean> {
  const data  = await loadContacts(wallet)
  const group = data.groups.find(g => g.name.toLowerCase() === groupName.toLowerCase())
  if (!group) return false

  const before = group.members.length
  group.members = group.members.filter(m => m.name.toLowerCase() !== memberName.toLowerCase())
  if (group.members.length === before) return false

  await saveContacts(wallet, data)
  return true
}

export async function listGroups(wallet: string): Promise<Group[]> {
  return (await loadContacts(wallet)).groups
}

export async function lookupGroup(wallet: string, groupName: string): Promise<Group | null> {
  const data = await loadContacts(wallet)
  return data.groups.find(g => g.name.toLowerCase() === groupName.toLowerCase()) ?? null
}

/**
 * Resolve a group name to member addresses.
 * Also auto-resolves member names to addresses from the contacts list.
 */
export async function resolveGroupMembers(
  wallet: string,
  groupName: string,
): Promise<{ name: string; address: string }[] | null> {
  const data  = await loadContacts(wallet)
  const group = data.groups.find(g => g.name.toLowerCase() === groupName.toLowerCase())
  if (!group) return null

  // Auto-resolve member names that might be stored by name only
  return group.members.map(m => {
    if (m.address) return m
    const contact = data.contacts.find(c => c.name.toLowerCase() === m.name.toLowerCase())
    return { name: m.name, address: contact?.address ?? '' }
  }).filter(m => m.address !== '')
}

/* ─── Payment count updater ──────────────────────────────────────────────── */

export async function incrementPaymentCount(wallet: string, recipientName: string): Promise<void> {
  try {
    const data = await loadContacts(wallet)
    const contact = data.contacts.find(c => c.name.toLowerCase() === recipientName.toLowerCase())
    if (!contact) return
    contact.paymentCount++
    await saveContacts(wallet, data)
  } catch { /* non-fatal */ }
}
