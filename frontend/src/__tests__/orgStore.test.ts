import { describe, it, expect, beforeEach } from 'vitest'
import { act } from '@testing-library/react'
import { useOrgStore } from '../store/orgStore'
import type { Organization } from '../types'

const orgs: Organization[] = [
  { id: 'org-001', name: 'Acme Corp', slug: 'acme' },
  { id: 'org-002', name: 'Beta Inc',  slug: 'beta'  },
]

describe('orgStore', () => {
  beforeEach(() => {
    act(() => {
      useOrgStore.getState().clearOrg()
    })
  })

  it('starts empty', () => {
    const state = useOrgStore.getState()
    expect(state.currentOrg).toBeNull()
    expect(state.organizations).toHaveLength(0)
  })

  it('setOrganizations auto-selects first org', () => {
    act(() => {
      useOrgStore.getState().setOrganizations(orgs)
    })
    const state = useOrgStore.getState()
    expect(state.organizations).toHaveLength(2)
    expect(state.currentOrg?.id).toBe('org-001')
  })

  it('setCurrentOrg changes the active org', () => {
    act(() => {
      useOrgStore.getState().setOrganizations(orgs)
    })
    act(() => {
      useOrgStore.getState().setCurrentOrg(orgs[1])
    })
    expect(useOrgStore.getState().currentOrg?.id).toBe('org-002')
  })

  it('setOrganizations keeps current org in sync when already selected', () => {
    act(() => {
      useOrgStore.getState().setOrganizations(orgs)
    })
    act(() => {
      useOrgStore.getState().setCurrentOrg(orgs[1])
    })
    // Re-load a fresh list (simulating a refetch) — current should stay org-002
    const updatedOrgs: Organization[] = [
      { id: 'org-001', name: 'Acme Corp', slug: 'acme' },
      { id: 'org-002', name: 'Beta Inc Updated', slug: 'beta' },
    ]
    act(() => {
      useOrgStore.getState().setOrganizations(updatedOrgs)
    })
    const state = useOrgStore.getState()
    expect(state.currentOrg?.id).toBe('org-002')
    expect(state.currentOrg?.name).toBe('Beta Inc Updated')
  })

  it('clearOrg resets state', () => {
    act(() => {
      useOrgStore.getState().setOrganizations(orgs)
    })
    act(() => {
      useOrgStore.getState().clearOrg()
    })
    const state = useOrgStore.getState()
    expect(state.currentOrg).toBeNull()
    expect(state.organizations).toHaveLength(0)
  })
})
