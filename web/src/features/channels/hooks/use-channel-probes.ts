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
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { runChannelProbe } from '../lib/channel-actions'
import {
  CHANNEL_PROBE_BY_ID,
  channelProbeQueue,
  type ChannelProbeJob,
  type ChannelProbeResult,
  type ChannelProbeResults,
} from '../lib/channel-test'

export type ChannelProbeProgress = {
  total: number
  completed: number
  passed: number
  failed: number
  degraded: number
  skipped: number
  cancelled: number
}

/** Patch the caller applies to its channel list cache once a run settles. */
export type ChannelProbeRunPatch = {
  responseTime: number
  testTime: number
}

type ProbeRun = {
  stopped: boolean
  jobs: ChannelProbeJob[]
}

const SETTLED_STATUSES = new Set(['queued', 'running', 'cancelled'])

export function useChannelProbes(
  channelId: number,
  onRunSettled?: (patch?: ChannelProbeRunPatch) => void
) {
  const { t } = useTranslation()
  const [results, setResults] = useState<ChannelProbeResults>({})
  const [isRunning, setIsRunning] = useState(false)
  const [isStopping, setIsStopping] = useState(false)
  const [runJobs, setRunJobs] = useState<ChannelProbeJob[]>([])
  const activeRun = useRef<ProbeRun | null>(null)
  const settledRef = useRef(onRunSettled)
  settledRef.current = onRunSettled

  const close = useCallback(() => {
    if (activeRun.current) activeRun.current.stopped = true
    activeRun.current = null
    channelProbeQueue.flushCancelled()
  }, [])

  useEffect(() => close, [close])

  const stop = useCallback(() => {
    const run = activeRun.current
    if (!run) return
    run.stopped = true
    setIsStopping(true)
    channelProbeQueue.flushCancelled()
    // Anything still queued never reached the channel, so it is cancelled
    // rather than failed.
    setResults((previous) => {
      const next = { ...previous }
      for (const job of run.jobs) {
        const result = next[job.model]?.[job.probe]
        if (result?.status === 'queued') {
          next[job.model] = {
            ...next[job.model],
            [job.probe]: { ...result, status: 'cancelled' },
          }
        }
      }
      return next
    })
  }, [])

  const start = useCallback(
    async (requestedJobs: ChannelProbeJob[]) => {
      if (activeRun.current || requestedJobs.length === 0) return
      const jobs = [
        ...new Map(
          requestedJobs.map((job) => [job.configurationKey, job])
        ).values(),
      ]
      const run: ProbeRun = { stopped: false, jobs }
      activeRun.current = run
      setRunJobs(jobs)
      setIsRunning(true)
      setIsStopping(false)
      setResults((previous) => {
        const next = { ...previous }
        for (const job of jobs) {
          next[job.model] = {
            ...next[job.model],
            [job.probe]: { ...job, status: 'queued' },
          }
        }
        return next
      })

      const completed: ChannelProbeResult[] = []
      await Promise.allSettled(
        jobs.map((job) =>
          channelProbeQueue.schedule(
            async () => {
              if (run.stopped || activeRun.current !== run) return
              setResults((previous) => ({
                ...previous,
                [job.model]: {
                  ...previous[job.model],
                  [job.probe]: { ...job, status: 'running' },
                },
              }))
              const spec = CHANNEL_PROBE_BY_ID[job.probe]
              let result: ChannelProbeResult
              try {
                const response = await runChannelProbe(channelId, {
                  testModel: job.model,
                  endpointType: job.endpoint === 'auto' ? '' : job.endpoint,
                  stream: spec.stream,
                  testType: spec.testType,
                  // A tool probe supplies its own instruction, so the
                  // configured message would only confuse the model.
                  message: spec.testType === 'tool_call' ? '' : job.message,
                })
                result = {
                  ...job,
                  status: response.diagnostics?.status ?? 'failed',
                  diagnostics: response.diagnostics,
                  completedAt: Date.now(),
                  error: response.message || response.diagnostics?.detail,
                  errorCode: response.diagnostics
                    ? response.error_code
                    : 'diagnostics_unavailable',
                  preview: response.response_preview,
                }
              } catch (error: unknown) {
                const failure = error as {
                  response?: {
                    data?: { message?: string; error_code?: string }
                  }
                }
                result = {
                  ...job,
                  status: 'failed',
                  completedAt: Date.now(),
                  error:
                    failure.response?.data?.message ||
                    t('The test request failed.'),
                  errorCode: failure.response?.data?.error_code,
                }
              }
              completed.push(result)
              if (activeRun.current !== run) return
              setResults((previous) => ({
                ...previous,
                [job.model]: { ...previous[job.model], [job.probe]: result },
              }))
            },
            () => run.stopped || activeRun.current !== run
          )
        )
      )

      // Report the newest measured probe once per run, including requests that
      // finished after the dialog closed.
      const latest = completed
        .filter((result) => result.diagnostics && result.status !== 'skipped')
        .sort((a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0))[0]
      if (latest?.diagnostics) {
        settledRef.current?.({
          responseTime: latest.diagnostics.duration_ms,
          testTime: Math.floor((latest.completedAt ?? Date.now()) / 1000),
        })
      }

      if (activeRun.current !== run) return
      activeRun.current = null
      setIsRunning(false)
      setIsStopping(false)

      const counts = {
        passed: completed.filter((result) => result.status === 'passed').length,
        failed: completed.filter((result) => result.status === 'failed').length,
        degraded: completed.filter((result) => result.status === 'degraded')
          .length,
      }
      const title = run.stopped ? t('Testing stopped') : t('Testing completed')
      const description = t(
        '{{passed}} passed · {{failed}} failed · {{degraded}} compatibility',
        counts
      )
      if (counts.failed > 0) toast.error(title, { description })
      else toast.info(title, { description })
    },
    [channelId, t]
  )

  const runResults = runJobs.map((job) => results[job.model]?.[job.probe])
  const progress: ChannelProbeProgress = {
    total: runJobs.length,
    completed: runResults.filter(
      (result) => result && !SETTLED_STATUSES.has(result.status)
    ).length,
    passed: runResults.filter((result) => result?.status === 'passed').length,
    failed: runResults.filter((result) => result?.status === 'failed').length,
    degraded: runResults.filter((result) => result?.status === 'degraded')
      .length,
    skipped: runResults.filter((result) => result?.status === 'skipped').length,
    cancelled: runResults.filter((result) => result?.status === 'cancelled')
      .length,
  }

  return { results, isRunning, isStopping, progress, start, stop, close }
}
