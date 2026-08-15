/*
Copyright (C) 2023-2026 QuantumNous

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as
published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program. If not, see <https://www.gnu.org/licenses/>.

For commercial licensing, please contact support@quantumnous.com
*/
import { zodResolver } from '@hookform/resolvers/zod'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Check,
  CloudUpload,
  Download,
  History,
  Loader2,
  RefreshCw,
  ShieldCheck,
} from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useForm } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import * as z from 'zod'

import { Dialog } from '@/components/dialog'
import { Alert, AlertDescription } from '@/components/ui/alert'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { formatTimestampToDate } from '@/lib/format'

import {
  downloadBackup,
  getBackupSettings,
  getCurrentBackupRestoreTask,
  getCurrentBackupTask,
  getSystemTask,
  listBackupRevisions,
  startBackup,
  startBackupRestore,
  testBackupConnection,
  updateBackupSettings,
  verifyBackup,
} from '../api'
import { SettingsCard } from '../components/settings-card'
import {
  SettingsForm,
  SettingsFormGrid,
  SettingsFormGridItem,
  SettingsSwitchContent,
  SettingsSwitchItem,
} from '../components/settings-form-layout'
import { SettingsPageFormActions } from '../components/settings-page-context'
import { SettingsSection } from '../components/settings-section'
import type { BackupRevision, BackupTask } from '../types'

const backupSchema = z.object({
  enabled: z.boolean(),
  interval_hours: z.string().refine((value) => {
    const parsed = Number(value)
    return Number.isInteger(parsed) && parsed >= 1 && parsed <= 8760
  }, 'Interval must be between 1 and 8760 hours'),
  gist_description: z.string().min(1).max(255),
  gist_id: z.string(),
  github_token: z.string(),
  age_identity: z.string(),
})

type BackupFormValues = z.infer<typeof backupSchema>

type BackupSettingsSectionProps = {
  defaultValues?: never
}

function formatBytes(bytes: number) {
  if (!bytes) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const index = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1
  )
  return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : 2)} ${units[index]}`
}

function isActiveTask(task: BackupTask | null) {
  return task?.status === 'pending' || task?.status === 'running'
}

function taskLabel(task: BackupTask | null, t: (key: string) => string) {
  if (!task) return t('No backup task running')
  if (task.status === 'pending') return t('Backup queued')
  if (task.status === 'running') {
    const stage = task.state?.stage
    switch (stage) {
      case 'dumping':
        return t('Backup: dumping database')
      case 'packaging':
        return t('Backup: packaging dump')
      case 'encrypting':
        return t('Backup: encrypting archive')
      case 'uploading':
        return t('Backup: uploading to Gist')
      case 'unchanged':
        return t('Backup: no changes')
      default:
        return t('Backup in progress')
    }
  }
  if (task.status === 'succeeded') return t('Backup completed')
  return t('Backup failed')
}

function backupStatusLabel(
  status: string | undefined,
  t: (key: string) => string
) {
  switch (status) {
    case 'succeeded':
      return t('Backup succeeded')
    case 'unchanged':
      return t('No database changes since the last backup')
    case 'verified':
      return t('Backup verified')
    case 'failed':
      return t('Backup failed')
    default:
      return status || t('Not backed up yet')
  }
}

async function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  URL.revokeObjectURL(url)
}

function BackupHistoryDialog({
  open,
  onOpenChange,
  onDownload,
  onRestore,
  busy,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onDownload: (revision: string) => void
  onRestore: (revision: string) => void
  busy: boolean
}) {
  const { t } = useTranslation()
  const revisionsQuery = useQuery({
    queryKey: ['backup-revisions'],
    queryFn: listBackupRevisions,
    enabled: open,
  })
  const revisions = revisionsQuery.data?.data ?? []
  let historyContent: ReactNode
  if (revisionsQuery.isLoading) {
    historyContent = (
      <div className='text-muted-foreground flex min-h-32 items-center justify-center text-sm'>
        {t('Loading backup history...')}
      </div>
    )
  } else if (revisionsQuery.isError) {
    historyContent = (
      <Alert variant='destructive'>
        <AlertDescription>
          {t('Failed to load backup history.')}
        </AlertDescription>
      </Alert>
    )
  } else if (revisions.length === 0) {
    historyContent = (
      <div className='text-muted-foreground flex min-h-32 items-center justify-center text-sm'>
        {t('No backup revisions found.')}
      </div>
    )
  } else {
    historyContent = (
      <div className='space-y-2'>
        {revisions.map((revision: BackupRevision) => (
          <div
            key={revision.version}
            className='bg-muted/20 flex flex-col gap-3 rounded-xl border p-3 sm:flex-row sm:items-center sm:justify-between'
          >
            <div className='min-w-0'>
              <p className='text-sm font-medium'>
                {revision.committed_at
                  ? new Date(revision.committed_at).toLocaleString()
                  : revision.version}
              </p>
              <p className='text-muted-foreground truncate text-xs'>
                {revision.version}
              </p>
            </div>
            <div className='flex flex-wrap gap-2'>
              <Button
                type='button'
                size='sm'
                variant='outline'
                onClick={() => onDownload(revision.version)}
                disabled={busy}
              >
                <Download data-icon='inline-start' />
                {t('Download')}
              </Button>
              <Button
                type='button'
                size='sm'
                variant='destructive'
                onClick={() => onRestore(revision.version)}
                disabled={busy}
              >
                <RefreshCw data-icon='inline-start' />
                {t('Restore')}
              </Button>
            </div>
          </div>
        ))}
      </div>
    )
  }

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={t('Backup history')}
      description={t(
        'Each entry is a complete encrypted PostgreSQL snapshot. Gist revisions are managed by GitHub.'
      )}
      contentClassName='sm:max-w-3xl'
    >
      {historyContent}
    </Dialog>
  )
}

export function BackupSettingsSection(_props: BackupSettingsSectionProps) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const settingsQuery = useQuery({
    queryKey: ['backup-settings'],
    queryFn: getBackupSettings,
  })
  const [historyOpen, setHistoryOpen] = useState(false)
  const [restoreRevision, setRestoreRevision] = useState<string | null>(null)
  const [task, setTask] = useState<BackupTask | null>(null)
  const [restoreTask, setRestoreTask] = useState<BackupTask | null>(null)
  const terminalTaskRef = useRef<string | null>(null)

  const form = useForm<BackupFormValues>({
    resolver: zodResolver(backupSchema),
    defaultValues: {
      enabled: false,
      interval_hours: '24',
      gist_description: 'New-API Auto Backup',
      gist_id: '',
      github_token: '',
      age_identity: '',
    },
  })

  useEffect(() => {
    const data = settingsQuery.data?.data
    if (!data) return
    form.reset({
      enabled: data.enabled,
      interval_hours: String(data.interval_hours || 24),
      gist_description: data.gist_description,
      gist_id: data.gist_id,
      github_token: '',
      age_identity: '',
    })
  }, [form, settingsQuery.data?.data])

  useEffect(() => {
    let cancelled = false
    void getCurrentBackupTask().then((response) => {
      if (!cancelled && response.success && response.data) {
        setTask(response.data)
      }
    })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    void getCurrentBackupRestoreTask().then((response) => {
      if (!cancelled && response.success && response.data) {
        setRestoreTask(response.data)
      }
    })
    return () => {
      cancelled = true
    }
  }, [])

  const activeTask = isActiveTask(task)
  const activeRestoreTask = isActiveTask(restoreTask)

  useEffect(() => {
    if (!task?.task_id || !activeTask) return
    let cancelled = false
    const interval = window.setInterval(async () => {
      try {
        const response = await queryClient.fetchQuery({
          queryKey: ['system-task', task.task_id],
          queryFn: async () => {
            const result = await getSystemTask<BackupTask>(task.task_id)
            return result.data
          },
          staleTime: 0,
        })
        if (cancelled || !response) return
        setTask(response)
        if (
          !isActiveTask(response) &&
          terminalTaskRef.current !== response.task_id
        ) {
          terminalTaskRef.current = response.task_id
          if (response.status === 'succeeded') {
            toast.success(t('Backup completed successfully.'))
            queryClient.invalidateQueries({ queryKey: ['backup-settings'] })
          } else if (response.status === 'failed') {
            toast.error(response.error || t('Backup failed.'))
          }
        }
      } catch {
        // Keep polling through transient network errors.
      }
    }, 1000)
    return () => {
      cancelled = true
      window.clearInterval(interval)
    }
  }, [activeTask, queryClient, t, task?.task_id])

  useEffect(() => {
    if (!restoreTask?.task_id || !activeRestoreTask) return
    let cancelled = false
    const interval = window.setInterval(async () => {
      try {
        const response = await queryClient.fetchQuery({
          queryKey: ['system-task', restoreTask.task_id],
          queryFn: async () => {
            const result = await getSystemTask<BackupTask>(restoreTask.task_id)
            return result.data
          },
          staleTime: 0,
        })
        if (cancelled || !response) return
        setRestoreTask(response)
        if (
          !isActiveTask(response) &&
          terminalTaskRef.current !== response.task_id
        ) {
          terminalTaskRef.current = response.task_id
          if (response.status === 'succeeded') {
            toast.success(t('Database restore completed.'))
            queryClient.invalidateQueries({ queryKey: ['backup-settings'] })
          } else if (response.status === 'failed') {
            toast.error(response.error || t('Database restore failed.'))
          }
        }
      } catch {
        // Keep polling through transient network errors.
      }
    }, 1000)
    return () => {
      cancelled = true
      window.clearInterval(interval)
    }
  }, [activeRestoreTask, queryClient, restoreTask?.task_id, t])

  const saveMutation = useMutation({
    mutationFn: updateBackupSettings,
    onSuccess: (response) => {
      if (!response.success) {
        toast.error(response.message || t('Failed to save backup settings.'))
        return
      }
      queryClient.invalidateQueries({ queryKey: ['backup-settings'] })
      toast.success(t('Backup settings saved.'))
    },
    onError: (error: Error) => toast.error(error.message),
  })

  const testMutation = useMutation({
    mutationFn: testBackupConnection,
    onSuccess: (response) => {
      if (response.success) toast.success(t('Backup connection is ready.'))
      else toast.error(response.message || t('Backup connection failed.'))
    },
    onError: (error: Error) => toast.error(error.message),
  })

  const startMutation = useMutation({
    mutationFn: startBackup,
    onSuccess: (response) => {
      if (!response.success || !response.data?.task) {
        toast.error(response.message || t('Failed to start backup.'))
        return
      }
      setTask(response.data.task)
      toast.success(
        response.data.created
          ? t('Backup task started.')
          : t('A backup task is already running.')
      )
    },
    onError: (error: Error) => toast.error(error.message),
  })

  const verifyMutation = useMutation({
    mutationFn: (revision?: string) => verifyBackup(revision),
    onSuccess: (response) => {
      if (!response.success || !response.data) {
        toast.error(response.message || t('Backup verification failed.'))
        return
      }
      queryClient.invalidateQueries({ queryKey: ['backup-settings'] })
      toast.success(t('Backup verified successfully.'))
    },
    onError: (error: Error) => toast.error(error.message),
  })

  const downloadMutation = useMutation({
    mutationFn: (revision?: string) => downloadBackup(revision),
    onSuccess: async (response, revision) => {
      const filename = revision
        ? `new-api-backup-${revision}.age`
        : 'new-api-backup-latest.age'
      await saveBlob(response.data, filename)
      toast.success(t('Encrypted backup downloaded.'))
    },
    onError: (error: Error) => toast.error(error.message),
  })

  const restoreMutation = useMutation({
    mutationFn: (revision: string) => startBackupRestore(revision),
    onSuccess: (response) => {
      if (!response.success || !response.data?.task) {
        toast.error(response.message || t('Failed to start database restore.'))
        return
      }
      setRestoreTask(response.data.task)
      setRestoreRevision(null)
      setHistoryOpen(false)
      toast.success(t('Database restore task started.'))
    },
    onError: (error: Error) => toast.error(error.message),
  })

  const onSubmit = async (values: BackupFormValues) => {
    await saveMutation.mutateAsync({
      enabled: values.enabled,
      interval_hours: Number(values.interval_hours),
      gist_description: values.gist_description.trim(),
      gist_id: values.gist_id.trim(),
      ...(values.github_token.trim()
        ? { github_token: values.github_token.trim() }
        : {}),
      ...(values.age_identity.trim()
        ? { age_identity: values.age_identity.trim() }
        : {}),
    })
  }

  const settings = settingsQuery.data?.data
  const controlsDisabled = !settings?.supported
  const busy =
    testMutation.isPending ||
    startMutation.isPending ||
    verifyMutation.isPending ||
    downloadMutation.isPending ||
    restoreMutation.isPending ||
    activeTask ||
    activeRestoreTask

  return (
    <SettingsSection title={t('Database Backup')}>
      <Form {...form}>
        <SettingsForm onSubmit={form.handleSubmit(onSubmit)} autoComplete='off'>
          <SettingsPageFormActions
            onSave={form.handleSubmit(onSubmit)}
            isSaving={saveMutation.isPending}
            isSaveDisabled={controlsDisabled}
            saveLabel='Save backup settings'
          />

          {!settings?.supported ? (
            <Alert variant='destructive'>
              <AlertDescription>
                {t(
                  'PostgreSQL full backups are currently supported only when New-API uses PostgreSQL.'
                )}
              </AlertDescription>
            </Alert>
          ) : null}

          {!settings?.crypto_secret_configured ? (
            <Alert>
              <AlertDescription>
                {t(
                  'Set a stable CRYPTO_SECRET or SESSION_SECRET before storing backup credentials. Otherwise they cannot be decrypted after restart.'
                )}
              </AlertDescription>
            </Alert>
          ) : null}

          <SettingsCard
            title={t('Backup settings')}
            description={t(
              'Back up the PostgreSQL database online, encrypt it with age, and store one private Gist with revision history.'
            )}
          >
            <SettingsFormGrid>
              <FormField
                control={form.control}
                name='enabled'
                render={({ field }) => (
                  <SettingsSwitchItem>
                    <SettingsSwitchContent>
                      <FormLabel>{t('Enable scheduled backups')}</FormLabel>
                      <FormDescription>
                        {t(
                          'The scheduler creates at most one backup task at a time.'
                        )}
                      </FormDescription>
                    </SettingsSwitchContent>
                    <FormControl>
                      <Switch
                        checked={field.value}
                        onCheckedChange={field.onChange}
                        disabled={controlsDisabled}
                      />
                    </FormControl>
                  </SettingsSwitchItem>
                )}
              />

              <FormField
                control={form.control}
                name='interval_hours'
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t('Backup interval (hours)')}</FormLabel>
                    <FormControl>
                      <Input type='number' min={1} max={8760} {...field} />
                    </FormControl>
                    <FormDescription>
                      {t(
                        'Default: 24 hours. The interval starts after the previous task.'
                      )}
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <SettingsFormGridItem span='full'>
                <FormField
                  control={form.control}
                  name='gist_description'
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>{t('Gist description')}</FormLabel>
                      <FormControl>
                        <Input {...field} />
                      </FormControl>
                      <FormDescription>
                        {t(
                          'Used to find the private Gist automatically when Gist ID is blank.'
                        )}
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </SettingsFormGridItem>

              <FormField
                control={form.control}
                name='gist_id'
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t('Gist ID (optional)')}</FormLabel>
                    <FormControl>
                      <Input
                        placeholder={t('Leave blank to auto-detect')}
                        {...field}
                      />
                    </FormControl>
                    <FormDescription>
                      {t(
                        'The ID is saved automatically after the first upload.'
                      )}
                    </FormDescription>
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name='github_token'
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t('GitHub Token')}</FormLabel>
                    <FormControl>
                      <Input
                        type='password'
                        autoComplete='new-password'
                        placeholder={
                          settings?.github_token_configured
                            ? t('Configured; leave blank to keep it')
                            : t('Token with private Gist access')
                        }
                        {...field}
                      />
                    </FormControl>
                    <FormDescription>
                      {settings?.github_token_configured
                        ? t('A token is already stored encrypted.')
                        : t(
                            'The token is write-only and never returned to the browser.'
                          )}
                    </FormDescription>
                  </FormItem>
                )}
              />

              <SettingsFormGridItem span='full'>
                <FormField
                  control={form.control}
                  name='age_identity'
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>{t('age private identity')}</FormLabel>
                      <FormControl>
                        <Textarea
                          rows={2}
                          autoComplete='new-password'
                          placeholder={
                            settings?.age_identity_configured
                              ? t('Configured; leave blank to keep it')
                              : t('AGE-SECRET-KEY-1...')
                          }
                          {...field}
                        />
                      </FormControl>
                      <FormDescription>
                        {t(
                          'Use an age X25519 identity. Keep a copy outside the VPS; it is required for recovery.'
                        )}
                      </FormDescription>
                    </FormItem>
                  )}
                />
              </SettingsFormGridItem>

              <SettingsFormGridItem span='full'>
                <div className='bg-muted/20 rounded-xl border p-3 text-sm'>
                  <p className='font-medium'>{t('Encryption recipient')}</p>
                  <p className='text-muted-foreground mt-1 text-xs break-all'>
                    {settings?.age_recipient || t('Not configured')}
                  </p>
                </div>
              </SettingsFormGridItem>
            </SettingsFormGrid>
          </SettingsCard>
        </SettingsForm>
      </Form>

      <SettingsCard
        title={t('Backup status')}
        description={t('The database remains online while a dump is created.')}
      >
        <div className='space-y-3'>
          <div className='grid gap-3 text-sm sm:grid-cols-2'>
            <div>
              <p className='text-muted-foreground'>{t('Last backup')}</p>
              <p className='font-medium'>
                {formatTimestampToDate(settings?.last_backup_at)}
              </p>
            </div>
            <div>
              <p className='text-muted-foreground'>{t('Status')}</p>
              <p className='font-medium'>
                {backupStatusLabel(settings?.last_backup_status, t)}
              </p>
            </div>
            <div>
              <p className='text-muted-foreground'>{t('Backup size')}</p>
              <p className='font-medium'>
                {formatBytes(settings?.last_backup_size ?? 0)}
              </p>
            </div>
            <div>
              <p className='text-muted-foreground'>{t('Revision')}</p>
              <p className='truncate font-medium'>
                {settings?.last_backup_revision || '-'}
              </p>
            </div>
          </div>
          {settings?.last_backup_error ? (
            <Alert variant='destructive'>
              <AlertDescription>{settings.last_backup_error}</AlertDescription>
            </Alert>
          ) : null}
          {activeTask || activeRestoreTask ? (
            <div className='bg-muted/20 rounded-xl border p-3'>
              <div className='flex items-center gap-2 text-sm font-medium'>
                <Loader2 className='size-4 animate-spin' />
                {activeRestoreTask
                  ? t('Restoring selected backup')
                  : taskLabel(task, t)}
              </div>
              <div className='bg-muted mt-2 h-2 overflow-hidden rounded-full'>
                <div
                  className='bg-primary h-full transition-all'
                  style={{
                    width: `${Math.max(
                      0,
                      Math.min(
                        100,
                        activeRestoreTask
                          ? (restoreTask?.state?.progress ?? 0)
                          : (task?.state?.progress ?? 0)
                      )
                    )}%`,
                  }}
                />
              </div>
            </div>
          ) : null}
        </div>
      </SettingsCard>

      <SettingsCard
        title={t('Backup actions')}
        description={t(
          'Manual actions use the same asynchronous task and toast patterns as other maintenance tools.'
        )}
      >
        <div className='flex flex-wrap gap-2'>
          <Button
            type='button'
            variant='outline'
            onClick={() => testMutation.mutate()}
            disabled={controlsDisabled || busy}
          >
            {testMutation.isPending ? (
              <Loader2 data-icon='inline-start' className='animate-spin' />
            ) : (
              <ShieldCheck data-icon='inline-start' />
            )}
            {t('Test connection')}
          </Button>
          <Button
            type='button'
            onClick={() => startMutation.mutate()}
            disabled={controlsDisabled || busy || activeTask}
          >
            {startMutation.isPending ? (
              <Loader2 data-icon='inline-start' className='animate-spin' />
            ) : (
              <CloudUpload data-icon='inline-start' />
            )}
            {t('Run backup now')}
          </Button>
          <Button
            type='button'
            variant='outline'
            onClick={() => verifyMutation.mutate(undefined)}
            disabled={controlsDisabled || busy}
          >
            {verifyMutation.isPending ? (
              <Loader2 data-icon='inline-start' className='animate-spin' />
            ) : (
              <Check data-icon='inline-start' />
            )}
            {t('Verify latest')}
          </Button>
          <Button
            type='button'
            variant='outline'
            onClick={() => downloadMutation.mutate(undefined)}
            disabled={controlsDisabled || busy}
          >
            {downloadMutation.isPending ? (
              <Loader2 data-icon='inline-start' className='animate-spin' />
            ) : (
              <Download data-icon='inline-start' />
            )}
            {t('Download latest')}
          </Button>
          <Button
            type='button'
            variant='outline'
            onClick={() => setHistoryOpen(true)}
            disabled={controlsDisabled || busy}
          >
            <History data-icon='inline-start' />
            {t('Backup history')}
          </Button>
        </div>
      </SettingsCard>

      <BackupHistoryDialog
        open={historyOpen}
        onOpenChange={setHistoryOpen}
        onDownload={(revision) => downloadMutation.mutate(revision)}
        onRestore={(revision) => setRestoreRevision(revision)}
        busy={busy}
      />

      <AlertDialog
        open={Boolean(restoreRevision)}
        onOpenChange={(open) => {
          if (!open && !restoreMutation.isPending) setRestoreRevision(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t('Restore this backup revision?')}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t(
                'This will replace the current PostgreSQL data with the selected snapshot. Stop user traffic and keep a current backup before continuing.'
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={restoreMutation.isPending}>
              {t('Cancel')}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (restoreRevision) restoreMutation.mutate(restoreRevision)
              }}
              disabled={restoreMutation.isPending}
            >
              {restoreMutation.isPending
                ? t('Starting restore...')
                : t('Restore database')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SettingsSection>
  )
}
/*
Copyright (C) 2023-2026 QuantumNous

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as
published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program. If not, see <https://www.gnu.org/licenses/>.
*/
