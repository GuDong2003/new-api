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
import { useTranslation } from 'react-i18next'

import type { CanvasLocalStatus } from '../lib/canvas-editor'

type CanvasSaveStatusProps = {
  localStatus: CanvasLocalStatus | 'saved'
  cloudStatus: string
  statusText?: string | null
  error?: string
}

export function CanvasSaveStatus(props: CanvasSaveStatusProps) {
  const { t } = useTranslation()
  const full = props.cloudStatus === 'full' && props.localStatus === 'saved'
  let text = props.localStatus === 'saved' ? props.statusText : null
  if (!text && props.localStatus === 'saving') text = t('Saving…')
  if (!text && props.localStatus === 'error') {
    text = t(props.error || 'Canvas not saved')
  }
  if (!text && props.localStatus === 'saved') {
    if (full) text = t('已保存到本地，云端空间不足，暂未上传。')
    else if (props.cloudStatus === 'synced') text = t('Synced')
    else if (props.cloudStatus === 'conflict')
      text = t(
        'Cloud conflict. Export your local canvas or reload the cloud version.'
      )
    else if (props.cloudStatus === 'error')
      text = t('Saved locally. Cloud save failed; try again later.')
    else text = t('Saved in this browser')
  }
  return (
    <p className='text-muted-foreground text-xs' role='status'>
      {text}
    </p>
  )
}
