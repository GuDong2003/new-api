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
import { useQuery } from '@tanstack/react-query'
import { useEffect } from 'react'

import { useDrawingStore } from '@/stores/drawing-store'

import { getUserGroups, getUserModels } from '../../api'
import { settingsForImageModel } from '../lib/image-settings'

export function useImageOptions(userId: number) {
  const group = useDrawingStore((state) => state.settings.group)
  const model = useDrawingStore((state) => state.settings.model)
  const groups = useQuery({
    queryKey: ['drawing-groups', userId],
    queryFn: getUserGroups,
  })
  const models = useQuery({
    queryKey: ['drawing-models', userId, group],
    queryFn: () => getUserModels(group),
    enabled: Boolean(group),
  })
  useEffect(() => {
    if (
      !groups.data?.length ||
      groups.data.some((item) => item.value === group)
    ) {
      return
    }
    useDrawingStore
      .getState()
      .updateSettings({ group: groups.data[0].value, model: '' })
  }, [groups.data, group])
  useEffect(() => {
    if (!models.isSuccess) return
    const modelStillAvailable = models.data.some((item) => item.value === model)
    if (modelStillAvailable) return
    const preferred = models.data.find((item) =>
      /gpt-image|dall-e|chatgpt-image/.test(item.value)
    )
    if (preferred) {
      const state = useDrawingStore.getState()
      state.updateSettings(
        settingsForImageModel(state.settings, preferred.value)
      )
    } else if (model) {
      useDrawingStore.getState().updateSettings({ model: '' })
    }
  }, [models.data, models.isSuccess, model])
  return { groups, models }
}
