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
import { useEffect, useMemo } from 'react'

import { useDrawingStore } from '@/stores/drawing-store'

import { getCanvasSetting, getUserGroups, getUserModels } from '../../api'
import { filterImageModels } from '../lib/image-models'
import {
  getImagePresetSize,
  getImageResolutionTier,
  getImageSizePreset,
  nearestOfferedResolution,
  settingsForImageModel,
  supportsImageSizePresets,
} from '../lib/image-settings'

const NO_WITHHELD_RESOLUTIONS: readonly string[] = []

export function useImageOptions(userId: number) {
  const group = useDrawingStore((state) => state.settings.group)
  const model = useDrawingStore((state) => state.settings.model)
  const size = useDrawingStore((state) => state.settings.size)
  const generationMode = useDrawingStore(
    (state) => state.settings.generationMode
  )
  const groups = useQuery({
    queryKey: ['drawing-groups', userId],
    queryFn: getUserGroups,
  })
  const models = useQuery({
    queryKey: ['drawing-models', userId, group],
    queryFn: () => getUserModels(group),
    enabled: Boolean(group),
  })
  // What the admin set for the user's own group. Without it the canvas keeps
  // choosing for itself, so a failed read is not worth an error toast.
  const canvasSetting = useQuery({
    queryKey: ['canvas-setting', userId],
    queryFn: getCanvasSetting,
    retry: false,
    meta: { errorToast: false },
  })
  const defaultModel = canvasSetting.data?.default_model
  const disabledResolutions =
    canvasSetting.data?.disabled_resolutions ?? NO_WITHHELD_RESOLUTIONS
  const imageModels = useMemo(
    () => filterImageModels(models.data || [], generationMode),
    [models.data, generationMode]
  )
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
    // Wait for the group's default model, or the canvas would settle on its
    // own pick first and keep it.
    if (!models.isSuccess || canvasSetting.isPending) return
    const modelStillAvailable = imageModels.some((item) => item.value === model)
    if (modelStillAvailable) return
    const preferred =
      imageModels.find((item) => item.value === defaultModel) ||
      (generationMode === 'description' &&
        imageModels.find((item) =>
          /gpt-image|dall-e|chatgpt-image/.test(item.value)
        )) ||
      imageModels[0]
    if (preferred) {
      const state = useDrawingStore.getState()
      state.updateSettings(
        settingsForImageModel(state.settings, preferred.value)
      )
    } else if (model) {
      useDrawingStore.getState().updateSettings({ model: '' })
    }
  }, [
    imageModels,
    models.isSuccess,
    canvasSetting.isPending,
    defaultModel,
    model,
    generationMode,
  ])
  useEffect(() => {
    // Read the store rather than this render: the pick above may have just
    // replaced the model and its size.
    const current = useDrawingStore.getState().settings
    // Only preset models pick their size by tier. A fixed-size model's size is
    // its own, even when it happens to match a preset.
    if (!current.model || !supportsImageSizePresets(current.model)) return
    if (current.size === 'auto') return
    // A size carried over from another model is billed by its longest side.
    const preset = getImageSizePreset(current.size, current.model)
    const tier = preset?.resolution ?? getImageResolutionTier(current.size)
    const offered = nearestOfferedResolution(tier, disabledResolutions)
    if (offered === tier) return
    useDrawingStore.getState().updateSettings({
      size: getImagePresetSize(
        preset?.aspectRatio ?? '1:1',
        offered,
        current.model
      ),
    })
  }, [size, model, disabledResolutions])
  return { groups, models, imageModels, disabledResolutions }
}
