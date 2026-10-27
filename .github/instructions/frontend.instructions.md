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
      <div className="page-header">
        <div>
          <h2 className="page-title">Page Title</h2>
          <p className="page-description">Description</p>
        </div>
      </div>
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

- Use locally compiled **TailwindCSS** utilities. Define shared tokens and component classes in `frontend/src/styles.css`, with mappings in `frontend/tailwind.config.cjs`.
- Use semantic slate/teal tokens: `bg-canvas`, `bg-surface`, `bg-subtle`, `text-primary`, `text-secondary`, `text-muted`, `border-edge`, and `border-strong`.
- Primary actions use `btn-primary` or `bg-accent text-on-accent hover:bg-accent-hover`. Status colors use `success`, `warning`, `danger`, `info`, or `violet`; use `*-solid text-white` on solid status buttons.
- Light mode is the default; `themeStore` preserves the saved preference. Avoid hardcoded dark-first colors or new light-mode override blocks.
- Use shared `page-header`, `page-title`, `page-description`, `panel`, `btn-secondary`, and `icon-button` classes. The layout owns outer page padding.
- Use `space-y-*` and `gap-*` for spacing. Reserve inline styles for dynamic dimensions, chart colors, or other values utilities cannot express.
- Charts: use **Recharts** for standard plots and CSS variables for neutral strokes/text. Custom SVG/canvas colors must follow the theme, as in `CostMap.tsx` and `ModelTopology.tsx`.
- Tables: wrap wide tables in `<div className="table-scroll" tabIndex={0}>`; retain existing sorting and pagination behavior.
- Responsive: mobile-first. Sidebar becomes a drawer below `lg` (1024 px). Check mobile form wrapping and metric grids.
- Accessibility: label inputs and icon buttons, preserve visible focus, and use shared `Modal`/`useDialogFocus` for dialog focus handling. Keep English and Chinese translations aligned.
- Keep the [design system guide](../../CONTRIBUTING.md#frontend-design-system) and [system shortcuts](../../docs/user-guide.md#system-keyboard-shortcuts) current when changing these conventions.

## Code Conventions

- All exports: named exports for components, default export for pages.
- Hooks: `useOrgId()` helper reads `currentOrg.id` from Zustand.
- Date formatting: always display from UNIX timestamp — `new Date(ts * 1000).toLocaleDateString()`.
- Currency: `Intl.NumberFormat('en-US', { style: 'currency', currency: org.currency }).format(amount)`.
- No `any` types — use `unknown` then narrow, or define proper interfaces.
