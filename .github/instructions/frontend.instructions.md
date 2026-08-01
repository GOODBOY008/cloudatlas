---
description: "Use when writing React/TypeScript frontend code for CloudAtlas: components, pages, API calls, state management with Zustand, data fetching with React Query, and TailwindCSS styling."
applyTo: ["frontend/src/**/*.tsx", "frontend/src/**/*.ts"]
---

# Frontend Patterns

## API Layer

```typescript
// All API calls go through src/lib/api.ts (axios instance)
import api from '@/lib/api';

// GET with React Query
const { data, isLoading, error } = useQuery({
  queryKey: ['expenses', orgId, { from, to, poolId }],
  queryFn: () => api.get<ExpenseListResponse>(`/orgs/${orgId}/expenses`, {
    params: { from, to, pool_id: poolId }
  }).then(r => r.data),
  staleTime: 30_000,
});

// Mutation
const createPool = useMutation({
  mutationFn: (body: CreatePoolRequest) =>
    api.post<Pool>(`/orgs/${orgId}/pools`, body).then(r => r.data),
  onSuccess: () => {
    queryClient.invalidateQueries({ queryKey: ['pools', orgId] });
    toast.success('Pool created');
  },
  onError: (e: ApiError) => toast.error(e.message),
});
```

## State Management (Zustand)

```typescript
// src/stores/authStore.ts
interface AuthStore {
  user: User | null;
  token: string | null;
  currentOrg: Organization | null;
  login(token: string, user: User): void;
  logout(): void;
  setOrg(org: Organization): void;
}

// src/stores/uiStore.ts
interface UIStore {
  sidebarOpen: boolean;
  notifications: Notification[];
  addNotification(n: Notification): void;
}
```

## Page Component Pattern

```typescript
// src/pages/SomePage.tsx
export default function SomePage() {
  const { currentOrg } = useAuthStore();
  const orgId = currentOrg!.id;

  const { data, isLoading } = useQuery({ ... });

  if (isLoading) return <PageSkeleton />;

  return (
    <div className="space-y-6">
      <PageHeader title="Page Title" subtitle="Description" />
      {/* widgets */}
    </div>
  );
}
```

## Type Definitions

```typescript
// All types in src/types/index.ts
// Use snake_case for API fields matching backend JSON
export interface Resource {
  id: string;
  organization_id: string;
  cloud_account_id: string;
  cloud_resource_id: string;
  resource_type: ResourceType;
  name: string | null;
  region: string | null;
  tags: Record<string, string>;
  meta: Record<string, unknown>;
  pool_id: string | null;
  total_cost: number;
  active: boolean;
  first_seen: number;  // UNIX timestamp
  last_seen: number;
}

// Enum types as TypeScript union types
export type ResourceType =
  | 'instance' | 'volume' | 'snapshot' | 'bucket'
  | 'rds_instance' | 'ip_address' | 'load_balancer'
  | 'k8s_pod' | 'savings_plan' | 'reserved_instances'
  | 'image' | 'snapshot_chain';
```

## Error Handling

```typescript
// Axios interceptor in api.ts: attach token + handle 401
api.interceptors.response.use(
  r => r,
  async error => {
    if (error.response?.status === 401) {
      // attempt token refresh, redirect to /login on failure
    }
    return Promise.reject(error);
  }
);

// Error display: use toast (react-hot-toast or sonner)
// Loading states: skeleton components (Tailwind animate-pulse)
// Empty states: <EmptyState message="No data found" />
```

## Styling Conventions

- Use **TailwindCSS** utility classes. No custom CSS except in `globals.css`.
- Color palette: zinc/slate for UI chrome; blue for primary actions; green/red/yellow for status.
- Use `space-y-*` and `gap-*` for spacing. Never inline styles.
- Charts: **Recharts** for all data visualization (LineChart, BarChart, PieChart, AreaChart).
- Table pattern: header + scrollable body, sort by column, pagination via `page`/`pageSize` query params.
- Responsive: mobile-first. Sidebar collapses to drawer on `sm` breakpoint.

## Code Conventions

- All exports: named exports for components, default export for pages.
- Hooks: `useOrgId()` helper reads `currentOrg.id` from Zustand.
- Date formatting: always display from UNIX timestamp — `new Date(ts * 1000).toLocaleDateString()`.
- Currency: `Intl.NumberFormat('en-US', { style: 'currency', currency: org.currency }).format(amount)`.
- No `any` types — use `unknown` then narrow, or define proper interfaces.
