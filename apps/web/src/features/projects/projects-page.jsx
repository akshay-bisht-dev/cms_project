'use client';

import { useState } from 'react';
import Link from 'next/link';
import { BriefcaseBusiness, Plus, Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input, NativeSelect } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Can } from '@/components/common/can';
import { PageHeader } from '@/components/common/page-header';
import { EmptyState, ErrorState } from '@/components/common/states';
import { useDebounce } from '@/hooks/use-debounce';
import { useUrlState } from '@/hooks/use-url-state';
import { formatDate } from '@/lib/format';
import { ProjectStatusBadge } from './badges';
import { ProjectDialog } from './project-dialog';
import { useProjects } from './queries';

export function ProgressBar({ value, label }) {
  const pct = Math.max(0, Math.min(100, value ?? 0));
  return (
    <div className="h-1.5 overflow-hidden rounded-full bg-muted" role="progressbar" aria-label={label} aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}>
      <div className="h-full rounded-full bg-primary" style={{ width: `${pct}%` }} />
    </div>
  );
}

export function ProjectsPage() {
  const [filters, setFilters] = useUrlState({ q: '', status: 'PLANNED,ACTIVE,ON_HOLD', mine: '' });
  const [search, setSearch] = useState(filters.q);
  const q = useDebounce(search);
  const [creating, setCreating] = useState(false);
  const params = Object.fromEntries(Object.entries({ ...filters, q }).filter(([, v]) => v));
  const projects = useProjects(params);

  return (
    <>
      <PageHeader
        title="Projects"
        description="Projects you are a member of, plus those shared with everyone."
        actions={
          <Can permission="projects.create">
            <Button onClick={() => setCreating(true)}>
              <Plus aria-hidden /> New project
            </Button>
          </Can>
        }
      />
      <div className="mb-4 flex flex-wrap gap-3" role="search" aria-label="Filter projects">
        <div className="relative min-w-56 flex-1 sm:flex-none">
          <Search className="pointer-events-none absolute top-2.5 left-3 size-4 text-muted-foreground" aria-hidden />
          <Input aria-label="Search projects" placeholder="Search name or code" className="pl-9" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <NativeSelect aria-label="Status" className="w-auto" value={filters.status} onChange={(e) => setFilters({ status: e.target.value })}>
          <option value="PLANNED,ACTIVE,ON_HOLD">Open</option>
          <option value="ACTIVE">Active</option>
          <option value="COMPLETED">Completed</option>
          <option value="">All</option>
        </NativeSelect>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" className="size-4 accent-[var(--primary)]" checked={filters.mine === 'true'} onChange={(e) => setFilters({ mine: e.target.checked ? 'true' : '' })} />
          Only mine
        </label>
      </div>
      {projects.isPending ? (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-40" />
          ))}
        </div>
      ) : projects.error ? (
        <Card>
          <ErrorState error={projects.error} onRetry={() => projects.refetch()} />
        </Card>
      ) : projects.data.length === 0 ? (
        <Card>
          <EmptyState icon={BriefcaseBusiness} title="No projects here" description="Try another filter, or create a project." />
        </Card>
      ) : (
        <ul className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {projects.data.map((p) => {
            const done = p.taskCounts.total ? (p.taskCounts.done / p.taskCounts.total) * 100 : 0;
            return (
              <li key={p.id}>
                <Link href={`/projects/${p.id}/board`} className="block h-full rounded-lg border bg-card p-5 shadow-xs transition-colors hover:border-primary/40">
                  <div className="mb-2 flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-xs font-medium text-muted-foreground">{p.code}</p>
                      <h2 className="truncate font-semibold">{p.name}</h2>
                    </div>
                    <ProjectStatusBadge status={p.status} />
                  </div>
                  <p className="mb-4 text-sm text-muted-foreground">
                    {p.manager ? `Managed by ${p.manager.name}` : 'No manager'}
                    {p.deadline ? ` · due ${formatDate(p.deadline)}` : ''}
                  </p>
                  <ProgressBar value={done} label={`${p.name} tasks done`} />
                  <p className="mt-2 text-xs text-muted-foreground">
                    {p.taskCounts.done} of {p.taskCounts.total} tasks done · {p.taskCounts.open} open
                  </p>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
      {creating && <ProjectDialog onClose={() => setCreating(false)} />}
    </>
  );
}
