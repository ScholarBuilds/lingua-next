import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect } from 'react'
import { request } from '@/lib/api-deck'
import type { StudioFlowRun, StudioTask } from '@/lib/api-studio'
import type { RunListItem } from '@/lib/api-pipeline'
import { subscribeFlowEvents, subscribePipelineEvents, subscribeTaskEvents } from './taskEvents'
import type { TaskCenterScope } from './taskQueries'

interface HistoryPage {
  tasks: StudioTask[]
  flows: StudioFlowRun[]
  pipeline: RunListItem[]
  next_cursor: string | null
}

function useRefresh() {
  const client = useQueryClient()
  useEffect(() => {
    const refresh = () => { void client.invalidateQueries({ queryKey: ['studio-tasks'] }) }
    const stops = [subscribeTaskEvents(refresh), subscribeFlowEvents(refresh), subscribePipelineEvents(refresh)]
    return () => stops.forEach(stop => stop())
  }, [client])
}

export function useTaskSummary() {
  useRefresh()
  return useQuery({ queryKey: ['studio-tasks', 'summary'],
    queryFn: ({ signal }) => request<{ active: number; attention: number; total: number }>('/api/studio/tasks/summary', { signal }),
    refetchInterval: 15_000,
  })
}

export function useTaskHistory(scope: TaskCenterScope, identity = '') {
  useRefresh()
  const query = useInfiniteQuery({
    queryKey: ['studio-tasks', 'history', scope, identity], initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) => request<HistoryPage>(`/api/studio/tasks/history?scope=${scope}&identity=${encodeURIComponent(identity)}${pageParam ? '&cursor=' + encodeURIComponent(pageParam) : ''}`, { signal }),
    getNextPageParam: page => page.next_cursor, refetchInterval: 15_000,
  })
  return { ...query, data: query.data ? {
    tasks: query.data.pages.flatMap(page => page.tasks), flows: query.data.pages.flatMap(page => page.flows),
    pipeline: query.data.pages.flatMap(page => page.pipeline),
  } : undefined }
}

export function useTaskActivity() {
  useRefresh()
  return useQuery({ queryKey: ['studio-tasks', 'activity'], refetchInterval: 15_000,
    queryFn: async ({ signal }) => {
      const result: HistoryPage = { tasks: [], flows: [], pipeline: [], next_cursor: null }
      let cursor: string | null = null
      do {
        const page: HistoryPage = await request(`/api/studio/tasks/history?scope=active&limit=100${cursor ? '&cursor=' + encodeURIComponent(cursor) : ''}`, { signal })
        result.tasks.push(...page.tasks); result.flows.push(...page.flows); result.pipeline.push(...page.pipeline)
        cursor = page.next_cursor
      } while (cursor)
      return result
    },
  })
}
