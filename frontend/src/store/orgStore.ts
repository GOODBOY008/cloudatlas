import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { Organization } from '../types'

interface OrgState {
  currentOrg: Organization | null
  organizations: Organization[]
  setCurrentOrg: (org: Organization) => void
  setOrganizations: (orgs: Organization[]) => void
  clearOrg: () => void
}

export const useOrgStore = create<OrgState>()(
  persist(
    (set) => ({
      currentOrg: null,
      organizations: [],

      setCurrentOrg: (org) => set({ currentOrg: org }),

      setOrganizations: (orgs) =>
        set((state) => ({
          organizations: orgs,
          // Keep current org in sync if already selected
          currentOrg:
            state.currentOrg
              ? orgs.find((o) => o.id === state.currentOrg!.id) ?? orgs[0] ?? null
              : orgs[0] ?? null,
        })),

      clearOrg: () => set({ currentOrg: null, organizations: [] }),
    }),
    {
      name: 'cloudatlas-org',
      partialize: (state) => ({
        currentOrg: state.currentOrg,
        organizations: state.organizations,
      }),
    }
  )
)
