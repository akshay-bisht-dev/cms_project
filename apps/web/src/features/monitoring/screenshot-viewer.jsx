'use client';

import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Download, Lock, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { ErrorState } from '@/components/common/states';
import { api } from '@/lib/api';
import { formatDate, formatTime } from '@/lib/format';
import { FAILURE_LABEL, describeInterval } from './labels';
import { monitoringKeys, openScreenshot, useMonitoringMutation } from './queries';

const ACCESS_LABEL = { VIEW_THUMB: 'Viewed thumbnail', VIEW: 'Viewed full size', DOWNLOAD: 'Downloaded' };

function AccessLog({ screenshotId, timeZone }) {
  const log = useQuery({ queryKey: monitoringKeys.accessLog(screenshotId), queryFn: async () => (await api.get(`/monitoring/screenshots/${screenshotId}/access-log`)).data });
  if (log.isPending) return <Skeleton className="h-16" />;
  if (log.error) return <ErrorState error={log.error} />;
  return (
    <ul className="max-h-40 space-y-1 overflow-y-auto text-xs">
      {log.data.map((entry, i) => (
        <li key={`${entry.at}-${i}`} className="flex justify-between gap-2">
          <span>
            {entry.actor.name} · {ACCESS_LABEL[entry.action] ?? entry.action}
          </span>
          <span className="text-muted-foreground">{formatDate(entry.at, { withTime: true, timeZone })}</span>
        </li>
      ))}
    </ul>
  );
}

/** Full-size view: fetched with a fresh 60-second signed URL (logged as a view). */
export function ScreenshotViewer({ screenshotId, timeZone, onClose }) {
  const [url, setUrl] = useState(null);
  const [urlError, setUrlError] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [showLog, setShowLog] = useState(false);
  const shot = useQuery({ queryKey: monitoringKeys.screenshot(screenshotId), queryFn: async () => (await api.get(`/monitoring/screenshots/${screenshotId}`)).data });
  const remove = useMonitoringMutation(() => api.delete(`/monitoring/screenshots/${screenshotId}`), { success: 'Screenshot deleted', onSuccess: onClose });

  const ready = shot.data?.status === 'READY';
  useEffect(() => {
    if (!ready) return;
    openScreenshot(screenshotId, 'full').then(setUrl, setUrlError);
  }, [ready, screenshotId]);

  async function download() {
    try {
      const signed = await openScreenshot(screenshotId, 'download');
      if (signed) window.location.assign(signed);
    } catch (error) {
      toast.error(error.message);
    }
  }

  const s = shot.data;
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-5xl">
        <DialogHeader>
          <DialogTitle>{s ? `${s.employee?.name ?? 'Screenshot'} · ${formatDate(s.capturedAt, { withTime: true, timeZone })}` : 'Screenshot'}</DialogTitle>
          <DialogDescription>{s?.project ? `${s.project.code} · ${s.project.name}${s.task ? ` — ${s.task.key} ${s.task.title}` : ''}` : 'No project or task was being tracked.'}</DialogDescription>
        </DialogHeader>
        {shot.isPending ? (
          <Skeleton className="aspect-video w-full" />
        ) : shot.error ? (
          <ErrorState error={shot.error} />
        ) : (
          <div className="grid gap-4 lg:grid-cols-[1fr_16rem]">
            <div className="grid min-h-48 place-items-center overflow-hidden rounded-md border bg-muted">
              {!ready ? (
                <p className="p-6 text-sm text-muted-foreground">{FAILURE_LABEL[s.failureCode] ?? (s.status === 'UPLOADED' ? 'Still processing' : s.status)}</p>
              ) : urlError ? (
                <ErrorState error={urlError} />
              ) : url ? (
                // Signed, short-lived URL from private storage; next/image would proxy and cache it.
                // eslint-disable-next-line @next/next/no-img-element
                <img src={url} alt={`Screenshot of ${s.employee?.name ?? 'the employee'}’s screen at ${formatTime(s.capturedAt, timeZone)}`} className="max-h-[70vh] w-full object-contain" />
              ) : (
                <Skeleton className="aspect-video w-full" />
              )}
            </div>
            <div className="grid content-start gap-3 text-sm">
              <dl className="grid gap-1">
                <dt className="text-muted-foreground">Policy</dt>
                <dd>{s.policy ? `${describeInterval(s.policy.intervalS)}${s.policy.blur ? ', blurred' : ''}` : '—'}</dd>
                <dt className="text-muted-foreground">Deleted automatically</dt>
                <dd>{s.legalHold ? 'Not while under legal hold' : formatDate(s.retentionExpiresAt, { timeZone })}</dd>
                {s.width ? (
                  <>
                    <dt className="text-muted-foreground">Size</dt>
                    <dd>
                      {s.width}×{s.height} · {Math.round((s.sizeBytes ?? 0) / 1024)} KB
                    </dd>
                  </>
                ) : null}
              </dl>
              {s.legalHold ? (
                <Badge tone="warning">
                  <Lock aria-hidden className="size-3" /> Legal hold
                </Badge>
              ) : null}
              <div className="flex flex-wrap gap-2">
                {s.canDownload ? (
                  <Button size="sm" variant="outline" onClick={download}>
                    <Download aria-hidden /> Download
                  </Button>
                ) : null}
                {s.canDelete ? (
                  <Button size="sm" variant="outline" onClick={() => setConfirmDelete(true)}>
                    <Trash2 aria-hidden /> Delete
                  </Button>
                ) : null}
              </div>
              {s.canViewAccessLog ? (
                <div className="grid gap-2">
                  <Button size="sm" variant="ghost" className="justify-start px-0" aria-expanded={showLog} onClick={() => setShowLog((v) => !v)}>
                    {showLog ? 'Hide access history' : 'Who has viewed this'}
                  </Button>
                  {showLog ? <AccessLog screenshotId={screenshotId} timeZone={timeZone} /> : null}
                </div>
              ) : null}
            </div>
          </div>
        )}
      </DialogContent>
      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogTitle>Delete this screenshot?</AlertDialogTitle>
          <AlertDialogDescription>The image is removed from storage permanently. A record that it existed and who deleted it is kept.</AlertDialogDescription>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction destructive onClick={() => remove.mutate()}>
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Dialog>
  );
}
