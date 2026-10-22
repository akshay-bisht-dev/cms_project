'use client';

import { useState } from 'react';
import { Plus } from 'lucide-react';
import { toast } from 'sonner';
import { Input } from '@/components/ui/input';
import { api } from '@/lib/api';
import { useInvalidateWork } from '@/features/projects/queries';

/** One-line task creation into a given status (board column) or the default status. */
export function QuickAddTask({ projectId, statusId, label = 'Add task' }) {
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const invalidate = useInvalidateWork();
  async function submit(event) {
    event.preventDefault();
    if (!title.trim()) return;
    setBusy(true);
    try {
      await api.post('/tasks', { projectId, title: title.trim(), ...(statusId ? { statusId } : {}) }, { idempotencyKey: crypto.randomUUID() });
      setTitle('');
      await invalidate();
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <form onSubmit={submit} className="relative">
      <Plus className="pointer-events-none absolute top-2.5 left-2.5 size-4 text-muted-foreground" aria-hidden />
      <Input aria-label={label} placeholder={label} value={title} disabled={busy} onChange={(e) => setTitle(e.target.value)} className="h-9 bg-card pl-8" maxLength={300} />
    </form>
  );
}
