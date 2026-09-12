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

For commercial licensing, please contact support@quantumnous.com
*/
import {
  FileAddIcon,
  FolderOpenIcon,
  SaveIcon,
} from '@hugeicons/core-free-icons'
import { HugeiconsIcon } from '@hugeicons/react'
import { Link, useNavigate } from '@tanstack/react-router'
import { useEffect, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

import { ConfirmDialog } from '@/components/confirm-dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { downloadBlob } from '@/features/playground/drawing/lib/image-assets'

import { useCanvasProjects } from '../hooks/use-canvas-projects'
import { exportCanvasProject } from '../lib/canvas-projects'
import type { CanvasKind } from '../types'
import { CanvasProjectDialog } from './canvas-project-dialog'
import { CanvasSaveStatus } from './canvas-save-status'

export function CanvasEditorHeader(props: {
  kind: CanvasKind
  children?: ReactNode
  toolbarLabel?: string
  statusDetail?: ReactNode
}) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const canvas = useCanvasProjects(props.kind)
  const current = canvas.current
  const [createOpen, setCreateOpen] = useState(false)
  const [reloadOpen, setReloadOpen] = useState(false)
  const [title, setTitle] = useState('')
  const [editingTitle, setEditingTitle] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setTitle(current?.name ?? '')
    setEditingTitle(false)
  }, [current?.id, current?.name])

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

  const cancelTitleEdit = () => {
    setTitle(current?.name ?? '')
    setEditingTitle(false)
  }

  const saveTitle = () => {
    if (!current || busy) return
    const normalized = title.trim()
    if (!normalized || normalized === current.name) {
      setTitle(current.name)
      setEditingTitle(false)
      return
    }
    void run(async () => {
      await canvas.rename(current.id, normalized)
      setTitle(normalized)
      setEditingTitle(false)
    })
  }

  return (
    <>
      <header
        className='bg-background grid min-w-0 shrink-0 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2 border-b px-3 py-2'
        role='toolbar'
        aria-label={props.toolbarLabel ?? t('Canvas tools')}
      >
        <div className='flex min-w-0 items-center gap-1 overflow-x-auto'>
          {props.children}
        </div>

        <div className='flex max-w-[min(42vw,28rem)] min-w-0 items-center justify-center gap-1'>
          <Button
            type='button'
            variant='ghost'
            size='icon-sm'
            disabled={busy}
            onClick={() => setCreateOpen(true)}
            aria-label={t('New canvas')}
            title={t('New canvas')}
          >
            <HugeiconsIcon icon={FileAddIcon} size={16} aria-hidden='true' />
          </Button>
          {editingTitle ? (
            <Input
              autoFocus
              aria-label={t('Canvas title')}
              value={title}
              placeholder={t('New canvas')}
              maxLength={255}
              disabled={!current || busy}
              className='h-7 min-w-0 text-center text-sm'
              onChange={(event) => setTitle(event.target.value)}
              onBlur={saveTitle}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  event.currentTarget.blur()
                } else if (event.key === 'Escape') {
                  event.preventDefault()
                  cancelTitleEdit()
                }
              }}
            />
          ) : (
            <Button
              type='button'
              variant='ghost'
              size='sm'
              disabled={!current || busy}
              className='h-7 max-w-[min(32vw,20rem)] min-w-0 truncate px-2 font-medium'
              aria-label={t('Canvas title')}
              title={t('Canvas title')}
              onClick={() => setEditingTitle(true)}
            >
              <span className='truncate'>{title || t('New canvas')}</span>
            </Button>
          )}
          <Button
            type='button'
            variant='ghost'
            size='icon-sm'
            render={<Link to='/canvas/gallery' />}
            aria-label={t('Open canvas')}
            title={t('Open canvas')}
          >
            <HugeiconsIcon icon={FolderOpenIcon} size={16} aria-hidden='true' />
          </Button>
        </div>

        <div className='flex min-w-0 items-center justify-end gap-1'>
          {props.statusDetail}
          <Button
            type='button'
            variant='ghost'
            size='icon-sm'
            onClick={() => void run(canvas.save)}
            disabled={!current || busy}
            aria-label={t('Save canvas')}
            title={t('Save canvas')}
          >
            <HugeiconsIcon icon={SaveIcon} size={16} aria-hidden='true' />
          </Button>
          <div className='max-w-48 min-w-0 truncate'>
            <CanvasSaveStatus
              localStatus={canvas.localStatus}
              cloudStatus={canvas.cloudStatus}
              statusText={canvas.statusText}
              error={canvas.localError}
            />
          </div>
          {canvas.localStatus === 'error' ||
          canvas.cloudStatus === 'conflict' ? (
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
      </header>
      {error ? (
        <p role='alert' className='text-destructive shrink-0 px-3 py-1 text-xs'>
          {t(error)}
        </p>
      ) : null}
      <CanvasProjectDialog
        open={createOpen}
        mode='create'
        initialKind={props.kind}
        fixedKind
        busy={busy}
        error={error}
        onOpenChange={setCreateOpen}
        onSubmit={(name) =>
          void run(async () => {
            const created = await canvas.create(name)
            await navigate({
              to: props.kind === 'drawing' ? '/canvas/drawing' : '/canvas/nai',
              search: { canvas: created.id },
            })
            setCreateOpen(false)
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
    </>
  )
}
