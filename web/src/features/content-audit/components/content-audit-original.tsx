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
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Dialog } from '@/components/dialog'
import { ErrorState } from '@/components/error-state'
import { LoadingState } from '@/components/loading-state'
import { Button } from '@/components/ui/button'

import { getContentAuditOriginal } from '../api'
import { useContentAuditAccess } from '../hooks/use-content-audit-access'
import { contentAuditErrorMessage } from '../lib/labels'
import type { ContentAuditImage } from '../types'
import { ContentAuditThumbnail } from './content-audit-thumbnail'

type OriginalFilePicker = (options: { suggestedName: string }) => Promise<{
  createWritable: () => Promise<WritableStream<Uint8Array>>
}>

// One owner per image page: replacing it cancels the stream and releases the
// explicitly buffered original. No original bytes enter the query cache.
export function ContentAuditOriginal(props: {
  recordId: string
  images: ContentAuditImage[]
}) {
  const { t } = useTranslation()
  const access = useContentAuditAccess()
  const active = useRef<AbortController | null>(null)
  const objectURL = useRef<string | null>(null)
  const [viewing, setViewing] = useState<number | null>(null)
  const [url, setURL] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [downloaded, setDownloaded] = useState(false)

  useEffect(
    () => () => {
      active.current?.abort()
      if (objectURL.current) URL.revokeObjectURL(objectURL.current)
    },
    []
  )

  function closeOriginal() {
    active.current?.abort()
    active.current = null
    if (objectURL.current) URL.revokeObjectURL(objectURL.current)
    objectURL.current = null
    setURL(null)
    setViewing(null)
    setBusy(false)
    setError(null)
    setDownloaded(false)
  }

  async function openOriginal(image: ContentAuditImage, download: boolean) {
    closeOriginal()
    const controller = new AbortController()
    active.current = controller
    setBusy(true)
    if (!download) setViewing(image.index)
    let writable: WritableStream<Uint8Array> | undefined
    try {
      if (download) {
        const picker = (
          window as Window & { showSaveFilePicker?: OriginalFilePicker }
        ).showSaveFilePicker
        if (!picker) {
          setError(
            t(
              'Streaming downloads require a supported browser, such as desktop Chromium.'
            )
          )
          return
        }
        const extension =
          image.original_mime === 'image/jpeg'
            ? 'jpg'
            : (image.original_mime?.split('/')[1] ?? 'png')
        // Invoke the native picker directly in the click's user activation.
        const file = await picker.call(window, {
          suggestedName: `audit-${props.recordId}-${image.index + 1}.${extension}`,
        })
        controller.signal.throwIfAborted()
        await access.run(async (signal) => {
          writable = await file.createWritable()
          signal.throwIfAborted()
          const original = await getContentAuditOriginal(
            props.recordId,
            image.index,
            signal
          )
          // Keep access.run registered until the body AND file close complete.
          await original.stream.pipeTo(writable, { signal })
        }, controller.signal)
        setDownloaded(true)
      } else {
        const blob = await access.run(async (signal) => {
          const original = await getContentAuditOriginal(
            props.recordId,
            image.index,
            signal
          )
          const chunks: BlobPart[] = []
          await original.stream.pipeTo(
            new WritableStream<Uint8Array>({
              write: (chunk) => {
                chunks.push(new Uint8Array(chunk))
              },
            }),
            { signal }
          )
          return new Blob(chunks, { type: original.mime })
        }, controller.signal)
        controller.signal.throwIfAborted()
        const nextURL = URL.createObjectURL(blob)
        objectURL.current = nextURL
        setURL(nextURL)
      }
    } catch (failure) {
      // Aborting a native file sink discards its unfinished temporary file.
      if (writable && !writable.locked) {
        await writable.abort().catch(() => undefined)
      }
      if (
        !controller.signal.aborted &&
        !(failure instanceof DOMException && failure.name === 'AbortError')
      ) {
        setError(
          download
            ? t(
                'Original download failed. Check file permissions and try again.'
              )
            : contentAuditErrorMessage(failure, t)
        )
      }
    } finally {
      if (active.current === controller && !controller.signal.aborted) {
        setBusy(false)
      }
    }
  }

  return (
    <div className='flex flex-col gap-3'>
      <div className='grid gap-3 sm:grid-cols-2'>
        {props.images.map((image) => (
          <ContentAuditThumbnail
            key={image.index}
            recordId={props.recordId}
            image={image}
            onView={() => void openOriginal(image, false)}
            onDownload={() => void openOriginal(image, true)}
          />
        ))}
      </div>
      {viewing === null && busy && (
        <div role='status' className='flex flex-wrap items-center gap-2'>
          <span>{t('Downloading original…')}</span>
          <Button variant='outline' size='sm' onClick={closeOriginal}>
            {t('Cancel download')}
          </Button>
        </div>
      )}
      {viewing === null && error && (
        <ErrorState description={error} className='min-h-0' />
      )}
      {downloaded && <p role='status'>{t('Original downloaded')}</p>}
      {viewing !== null && (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) closeOriginal()
          }}
          title={t('Original image {{index}}', { index: viewing + 1 })}
          description={t(
            'Viewing an original loads one full image into memory. Large images may use substantial memory; downloading streams to a file instead.'
          )}
          contentClassName='sm:max-w-5xl'
          footer={
            <Button variant='outline' onClick={closeOriginal}>
              {t('Close original')}
            </Button>
          }
        >
          {busy && <LoadingState />}
          {error && <ErrorState description={error} />}
          {url && (
            <img
              src={url}
              alt={t('Original image {{index}}', { index: viewing + 1 })}
              className='max-h-[65vh] max-w-full object-contain'
              onError={() => {
                URL.revokeObjectURL(url)
                objectURL.current = null
                setURL(null)
                setError(
                  t('Original image cannot be displayed. Try downloading it.')
                )
              }}
            />
          )}
        </Dialog>
      )}
    </div>
  )
}
