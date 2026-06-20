/**
 * ContactsPage — full-screen overlay for managing contacts and groups.
 * Reads/writes via /api/contacts/:wallet and /api/groups/:wallet.
 */

import { useState, useEffect } from 'react'
import { useAuthFetch } from './lib/authFetch.js'

/* ─── Types ──────────────────────────────────────────────────────────────── */

interface Contact {
  name:         string
  address:      string
  note?:        string
  createdAt:    number
  paymentCount: number
}

interface Group {
  name:      string
  members:   { name: string; address: string }[]
  createdAt: number
}

interface ContactsPageProps {
  wallet:  string
  onClose: () => void
}

/* ─── Helpers ─────────────────────────────────────────────────────────────── */

function truncateAddr(addr: string): string {
  if (addr.length <= 14) return addr
  return `${addr.slice(0, 8)}…${addr.slice(-6)}`
}

/** Accept a 0x address or a SuiNS name (e.g. "mum.sui" or "@mum"). The server
 *  resolves names to addresses on save. */
function isValidRecipient(v: string): boolean {
  const s = v.trim().toLowerCase()
  if (/^0x[0-9a-f]{1,64}$/.test(s) && s.length >= 10) return true
  if (s.startsWith('@') && s.length > 1) return true
  return /^[a-z0-9-]+(\.[a-z0-9-]+)*\.sui$/.test(s)
}

function Empty({ label }: { label: string }) {
  return <p className="text-xs text-slate-600 text-center py-10">{label}</p>
}

function Spinner() {
  return (
    <svg className="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
    </svg>
  )
}

/* ─── ContactsPage ───────────────────────────────────────────────────────── */

export function ContactsPage({ wallet, onClose }: ContactsPageProps) {
  const { signedFetch }         = useAuthFetch()
  const [tab,      setTab]      = useState<'contacts' | 'groups'>('contacts')
  const [contacts, setContacts] = useState<Contact[]>([])
  const [groups,   setGroups]   = useState<Group[]>([])
  const [loading,  setLoading]  = useState(true)
  const [error,    setError]    = useState<string | null>(null)

  /* ─ Add contact form ─ */
  const [addName, setAddName] = useState('')
  const [addAddr, setAddAddr] = useState('')
  const [addNote, setAddNote] = useState('')
  const [adding,  setAdding]  = useState(false)
  const [addErr,  setAddErr]  = useState<string | null>(null)

  /* ─ Create group form ─ */
  const [groupName,      setGroupName]      = useState('')
  const [groupMembers,   setGroupMembers]   = useState<{ name: string; address: string }[]>([{ name: '', address: '' }])
  const [creatingGroup,  setCreatingGroup]  = useState(false)
  const [groupErr,       setGroupErr]       = useState<string | null>(null)

  async function load() {
    setLoading(true)
    setError(null)
    try {
      // GET /api/contacts/:wallet returns { ok, contacts, groups }
      const data = await fetch(`/api/contacts/${wallet}`).then(r => r.json())
      if (data.ok) {
        setContacts(data.contacts ?? [])
        setGroups(data.groups ?? [])
      } else {
        setError(data.error ?? 'Failed to load contacts.')
      }
    } catch {
      setError('Failed to load contacts.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [wallet])

  /* ─── Add contact ─────────────────────────────────────────────────────── */
  async function handleAddContact(e: React.FormEvent) {
    e.preventDefault()
    setAddErr(null)
    const name = addName.trim()
    const addr = addAddr.trim()
    if (!name || !addr) { setAddErr('Name and address are required.'); return }
    if (!isValidRecipient(addr)) { setAddErr('Enter a 0x Sui address or a SuiNS name (e.g. mum.sui).'); return }
    setAdding(true)
    try {
      const res  = await signedFetch(`/api/contacts/${wallet}`, {
        method: 'POST',
        body:   JSON.stringify({ name, address: addr, note: addNote.trim() || undefined }),
      })
      const json = await res.json()
      if (!json.ok) throw new Error(json.error ?? 'Failed to add contact')
      setAddName(''); setAddAddr(''); setAddNote('')
      await load()
    } catch (err: any) {
      setAddErr(err.message ?? 'Failed to add contact.')
    } finally {
      setAdding(false)
    }
  }

  /* ─── Delete contact ─────────────────────────────────────────────────── */
  async function handleDeleteContact(name: string) {
    await signedFetch(`/api/contacts/${wallet}/${encodeURIComponent(name)}`, { method: 'DELETE' })
    setContacts(prev => prev.filter(c => c.name !== name))
  }

  /* ─── Create group ───────────────────────────────────────────────────── */
  function setMemberField(i: number, field: 'name' | 'address', value: string) {
    setGroupMembers(prev => {
      const next = [...prev]
      next[i] = { ...next[i], [field]: value }
      return next
    })
  }

  function addMemberRow() {
    setGroupMembers(prev => [...prev, { name: '', address: '' }])
  }

  function removeMemberRow(i: number) {
    setGroupMembers(prev => prev.filter((_, idx) => idx !== i))
  }

  async function handleCreateGroup(e: React.FormEvent) {
    e.preventDefault()
    setGroupErr(null)
    const name    = groupName.trim()
    const members = groupMembers.filter(m => m.name.trim() && m.address.trim())
    if (!name)              { setGroupErr('Group name is required.'); return }
    if (members.length < 1) { setGroupErr('Add at least one member.'); return }
    for (const m of members) {
      if (!isValidRecipient(m.address)) {
        setGroupErr(`Invalid address for member "${m.name}" — use a 0x address or SuiNS name.`); return
      }
    }
    setCreatingGroup(true)
    try {
      const res  = await signedFetch(`/api/groups/${wallet}`, {
        method: 'POST',
        body:   JSON.stringify({ name, members }),
      })
      const json = await res.json()
      if (!json.ok) throw new Error(json.error ?? 'Failed to create group')
      setGroupName(''); setGroupMembers([{ name: '', address: '' }])
      await load()
    } catch (err: any) {
      setGroupErr(err.message ?? 'Failed to create group.')
    } finally {
      setCreatingGroup(false)
    }
  }

  /* ─── Render ─────────────────────────────────────────────────────────── */
  return (
    /* Backdrop */
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm"
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      {/* Panel */}
      <div className="relative w-full max-w-xl max-h-[90vh] bg-[#0d0d12] border border-white/10 rounded-2xl shadow-2xl flex flex-col overflow-hidden">

        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-white/5 shrink-0">
          <div className="flex items-center gap-3">
            <span className="text-xs font-mono uppercase tracking-widest text-purple-400">Contacts</span>
          </div>
          <button
            onClick={onClose}
            className="w-7 h-7 flex items-center justify-center rounded-lg text-slate-500 hover:text-white hover:bg-white/5 transition-colors"
          >
            ✕
          </button>
        </div>

        {/* Tab bar */}
        <div className="flex border-b border-white/5 shrink-0 px-6">
          {(['contacts', 'groups'] as const).map(t => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`mr-6 py-3 text-xs uppercase tracking-widest font-mono transition-colors border-b-2 ${
                tab === t
                  ? 'text-purple-400 border-purple-500'
                  : 'text-slate-600 border-transparent hover:text-slate-400'
              }`}
            >
              {t}
            </button>
          ))}
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6">

          {loading && (
            <div className="flex justify-center py-12">
              <Spinner />
            </div>
          )}

          {error && (
            <p className="text-xs text-red-400 text-center py-8">{error}</p>
          )}

          {!loading && !error && tab === 'contacts' && (
            <>
              {/* Add contact form */}
              <form onSubmit={handleAddContact} className="rounded-xl bg-[#111118] p-4 space-y-3">
                <p className="text-[10px] font-mono uppercase tracking-widest text-slate-500">New Contact</p>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                  <input
                    value={addName}
                    onChange={e => setAddName(e.target.value)}
                    placeholder="Name (e.g. Mum)"
                    className="col-span-1 bg-white/5 border border-white/8 rounded-lg px-3 py-2 text-sm text-white placeholder:text-slate-600 focus:outline-none focus:border-purple-500/40"
                  />
                  <input
                    value={addAddr}
                    onChange={e => setAddAddr(e.target.value)}
                    placeholder="0x… or name.sui"
                    className="col-span-1 bg-white/5 border border-white/8 rounded-lg px-3 py-2 text-sm text-white placeholder:text-slate-600 focus:outline-none focus:border-purple-500/40 font-mono text-xs"
                  />
                </div>
                <input
                  value={addNote}
                  onChange={e => setAddNote(e.target.value)}
                  placeholder="Note (optional)"
                  className="w-full bg-white/5 border border-white/8 rounded-lg px-3 py-2 text-sm text-white placeholder:text-slate-600 focus:outline-none focus:border-purple-500/40"
                />
                {addErr && <p className="text-xs text-red-400">{addErr}</p>}
                <button
                  type="submit"
                  disabled={adding}
                  className="flex items-center gap-2 px-4 py-2 rounded-lg bg-purple-600/20 hover:bg-purple-600/40 border border-purple-500/30 text-purple-300 text-xs font-semibold transition-colors disabled:opacity-40"
                >
                  {adding && <Spinner />}
                  {adding ? 'Saving…' : 'Add Contact'}
                </button>
              </form>

              {/* Contact list */}
              {contacts.length === 0 ? (
                <Empty label='No contacts yet. Add one above, or say "pay Mum 50 USDC" after saving.' />
              ) : (
                <div className="space-y-2">
                  {contacts.map(c => (
                    <div
                      key={c.name}
                      className="flex items-center justify-between px-4 py-3 rounded-xl bg-[#111118]"
                    >
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="w-7 h-7 rounded-full bg-purple-600/20 text-purple-400 text-xs font-bold flex items-center justify-center shrink-0">
                            {c.name[0].toUpperCase()}
                          </span>
                          <div>
                            <p className="text-sm text-white font-medium">{c.name}</p>
                            <p className="text-[10px] text-slate-600 font-mono">{truncateAddr(c.address)}</p>
                          </div>
                        </div>
                        {c.note && <p className="text-[10px] text-slate-600 mt-1 pl-9">{c.note}</p>}
                      </div>
                      <div className="flex items-center gap-3 shrink-0 ml-3">
                        {c.paymentCount > 0 && (
                          <span className="text-[10px] text-slate-600">{c.paymentCount} pays</span>
                        )}
                        <button
                          onClick={() => handleDeleteContact(c.name)}
                          className="text-[10px] text-slate-600 hover:text-red-400 transition-colors"
                        >
                          remove
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}

          {!loading && !error && tab === 'groups' && (
            <>
              {/* Create group form */}
              <form onSubmit={handleCreateGroup} className="rounded-xl bg-[#111118] p-4 space-y-3">
                <p className="text-[10px] font-mono uppercase tracking-widest text-slate-500">New Group</p>
                <input
                  value={groupName}
                  onChange={e => setGroupName(e.target.value)}
                  placeholder="Group name (e.g. Staff, Contractors)"
                  className="w-full bg-white/5 border border-white/8 rounded-lg px-3 py-2 text-sm text-white placeholder:text-slate-600 focus:outline-none focus:border-purple-500/40"
                />
                <div className="space-y-2">
                  {groupMembers.map((m, i) => (
                    <div key={i} className="flex items-center gap-2">
                      <input
                        value={m.name}
                        onChange={e => setMemberField(i, 'name', e.target.value)}
                        placeholder="Name"
                        className="w-32 shrink-0 bg-white/5 border border-white/8 rounded-lg px-3 py-2 text-xs text-white placeholder:text-slate-600 focus:outline-none focus:border-purple-500/40"
                      />
                      <input
                        value={m.address}
                        onChange={e => setMemberField(i, 'address', e.target.value)}
                        placeholder="0x… or name.sui"
                        className="flex-1 min-w-0 bg-white/5 border border-white/8 rounded-lg px-3 py-2 text-xs text-white placeholder:text-slate-600 focus:outline-none focus:border-purple-500/40 font-mono"
                      />
                      {groupMembers.length > 1 && (
                        <button
                          type="button"
                          onClick={() => removeMemberRow(i)}
                          className="text-slate-600 hover:text-red-400 text-xs shrink-0"
                        >
                          ✕
                        </button>
                      )}
                    </div>
                  ))}
                </div>
                <button
                  type="button"
                  onClick={addMemberRow}
                  className="text-xs text-slate-500 hover:text-purple-400 transition-colors"
                >
                  + Add member
                </button>
                {groupErr && <p className="text-xs text-red-400">{groupErr}</p>}
                <button
                  type="submit"
                  disabled={creatingGroup}
                  className="flex items-center gap-2 px-4 py-2 rounded-lg bg-purple-600/20 hover:bg-purple-600/40 border border-purple-500/30 text-purple-300 text-xs font-semibold transition-colors disabled:opacity-40"
                >
                  {creatingGroup && <Spinner />}
                  {creatingGroup ? 'Creating…' : 'Create Group'}
                </button>
              </form>

              {/* Group list */}
              {groups.length === 0 ? (
                <Empty label='No groups yet. Create one above, or say "pay my staff 100 USDC each".' />
              ) : (
                <div className="space-y-3">
                  {groups.map(g => (
                    <div key={g.name} className="rounded-xl bg-[#111118] p-4 space-y-3">
                      <div className="flex items-center justify-between">
                        <span className="text-sm font-semibold text-white">{g.name}</span>
                        <span className="text-[10px] text-slate-600">{g.members.length} members</span>
                      </div>
                      <div className="space-y-1">
                        {g.members.map(m => (
                          <div key={m.name} className="flex items-center justify-between text-xs">
                            <span className="text-slate-400">{m.name}</span>
                            <span className="text-slate-600 font-mono">{truncateAddr(m.address)}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>

        {/* Footer hint */}
        <div className="shrink-0 px-6 py-3 border-t border-white/5">
          <p className="text-[10px] text-slate-700 text-center">
            Stored on Walrus · Say "pay {tab === 'contacts' ? '[name]' : 'my [group]'} 50 USDC" to use
          </p>
        </div>
      </div>
    </div>
  )
}
