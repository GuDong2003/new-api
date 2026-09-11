/*
Copyright (C) 2023-2026 QuantumNous

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program. If not, see <https://www.gnu.org/licenses/>.
*/
import { Link, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { ConfirmDialog } from '@/components/confirm-dialog'
import { Button } from '@/components/ui/button'
import { downloadBlob } from '@/features/playground/drawing/lib/image-assets'

import { useCanvasProjects } from '../hooks/use-canvas-projects'
import { exportCanvasProject } from '../lib/canvas-projects'
import type { CanvasKind } from '../types'
import { CanvasProjectDialog } from './canvas-project-dialog'
import { CanvasSaveStatus } from './canvas-save-status'

export function CanvasEditorHeader(props: { kind: CanvasKind }) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const canvas = useCanvasProjects(props.kind)
  const current = canvas.current
  const [dialog, setDialog] = useState<'create' | 'rename' | null>(null)
  const [reloadOpen, setReloadOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const run = async (action: () => Promise<unknown>) => {
    setError(null)
    setBusy(true)
    try {
      await action()
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Request failed')
    } finally {
      setBusy(false)
    }
  }
  const exportLocal = () =>
    void run(async () =>
      downloadBlob(
        await exportCanvasProject(canvas.identity, props.kind),
        `new-api-${props.kind}-canvas.json`
      )
    )
  return (
    <header className='bg-background flex shrink-0 flex-wrap items-center gap-2 border-b px-3 py-2'>
      <strong
        className='max-w-56 min-w-0 truncate text-sm'
        title={current?.name}
      >
        {current?.name ?? t('New canvas')}
      </strong>
      <span className='text-muted-foreground text-xs'>
        {props.kind === 'nai' ? t('NAI Canvas') : t('Drawing')}
      </span>
      <div className='ml-auto flex flex-wrap items-center gap-1'>
        <Button
          size='sm'
          variant='ghost'
          disabled={busy}
          onClick={() => setDialog('create')}
        >
          {t('New canvas')}
        </Button>
        <Button
          size='sm'
          variant='ghost'
          render={<Link to='/canvas/gallery' />}
        >
          {t('Open canvas')}
        </Button>
        <Button
          size='sm'
          variant='ghost'
          onClick={() => setDialog('rename')}
          disabled={!current || busy}
        >
          {t('Rename canvas')}
        </Button>
        <Button
          size='sm'
          variant='outline'
          onClick={() => void run(canvas.save)}
          disabled={!current || busy}
        >
          {t('Save')}
        </Button>
        {canvas.localStatus === 'error' || canvas.cloudStatus === 'conflict' ? (
          <Button
            size='sm'
            variant='outline'
            disabled={busy}
            onClick={exportLocal}
          >
            {t('Export canvas')}
          </Button>
        ) : null}
        {canvas.cloudStatus === 'conflict' ? (
          <Button
            size='sm'
            variant='outline'
            disabled={busy}
            onClick={() => setReloadOpen(true)}
          >
            {t('Reload cloud version')}
          </Button>
        ) : null}
      </div>
      <div className='w-full min-w-0'>
        <CanvasSaveStatus
          localStatus={canvas.localStatus}
          cloudStatus={canvas.cloudStatus}
          statusText={canvas.statusText}
          error={canvas.localError}
        />
        {error ? (
          <p role='alert' className='text-destructive text-xs break-words'>
            {t(error)}
          </p>
        ) : null}
      </div>
      <CanvasProjectDialog
        open={dialog !== null}
        mode={dialog ?? 'create'}
        initialKind={props.kind}
        fixedKind
        initialName={dialog === 'rename' ? current?.name : undefined}
        busy={busy}
        error={error}
        onOpenChange={(open) => {
          if (!open) setDialog(null)
        }}
        onSubmit={(name) =>
          void run(async () => {
            if (dialog === 'create') {
              const created = await canvas.create(name)
              await navigate({
                to:
                  props.kind === 'drawing' ? '/canvas/drawing' : '/canvas/nai',
                search: { canvas: created.id },
              })
            } else if (current) await canvas.rename(current.id, name)
            setDialog(null)
          })
        }
      />
      <ConfirmDialog
        open={reloadOpen}
        onOpenChange={setReloadOpen}
        title={t('Reload cloud version')}
        desc={t(
          'This discards the local conflicting version. Export it first if you need a copy.'
        )}
        isLoading={busy}
        destructive
        confirmText={t('Reload')}
        handleConfirm={() =>
          void run(async () => {
            if (current) await canvas.reloadConflict(current.id)
            setReloadOpen(false)
          })
        }
      >
        {error ? <p role='alert'>{t(error)}</p> : null}
      </ConfirmDialog>
    </header>
  )
}
