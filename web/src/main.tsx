import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { createBrowserRouter, Navigate, RouterProvider } from 'react-router-dom'

import { App } from './App'
import { connectLearningSync } from './lib/learningSync'
import { RouteError } from './components/RouteError'
import { TodayPage } from './features/home/TodayPage'
import './styles/app.css'
import './styles/workspace.css'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
      staleTime: 30_000,
      // 本地代理请求不依赖 onLine 探测，避免内嵌浏览器误判离线后请求被挂起
      networkMode: 'always',
    },
    mutations: {
      networkMode: 'always',
    },
  },
})

const disconnectLearningSync = connectLearningSync(queryClient)
if (import.meta.hot) import.meta.hot.dispose(disconnectLearningSync)

// Router 7.18 的 lazy 失败后仍参与 fallback 匹配，叶子 fallback 保留该层错误边界。
const routeRecovery = { errorElement: <RouteError />, hydrateFallbackElement: <p className="state-block" role="status">正在加载页面…</p> }

const router = createBrowserRouter([
  {
    path: '/',
    element: <App />,
    children: [
      { index: true, ...routeRecovery, element: <TodayPage /> },
      { path: 'read', ...routeRecovery, lazy: async () => ({ Component: (await import('./features/shelf/ShelfPage')).ShelfPage }) },
      // 旧地址：书签与外链还指着 /content
      { path: 'content', ...routeRecovery, element: <Navigate to="/read" replace /> },
      { path: 'read/:articleId', ...routeRecovery, lazy: async () => ({ Component: (await import('./features/reader/ReaderPage')).ReaderPage }) },
      { path: 'vocab', ...routeRecovery, lazy: async () => ({ Component: (await import('./features/vocab/VocabPage')).VocabPage }) },
      { path: 'dict', ...routeRecovery, lazy: async () => ({ Component: (await import('./features/vocab/dict/DictPage')).DictPage }) },
      { path: 'software-english', ...routeRecovery, lazy: async () => ({ Component: (await import('./features/grammar/SoftwareEnglishLegacyRedirect')).SoftwareEnglishLegacyRedirect }) },
      { path: 'grammar', ...routeRecovery, lazy: async () => ({ Component: (await import('./features/grammar/GrammarPage')).GrammarPage }) },
      { path: 'image', ...routeRecovery, lazy: async () => ({ Component: (await import('./features/image/ImagePage')).ImagePage }) },
      // 应用即路由：换应用换 URL，可收藏、可后退（FR-428）
      { path: 'image/:appKey', ...routeRecovery, lazy: async () => ({ Component: (await import('./features/image/ImagePage')).ImagePage }) },
      { path: 'studio', ...routeRecovery, lazy: async () => ({ Component: (await import('./features/studio/StudioHomePage')).default }) },
      { path: 'studio/canvas', ...routeRecovery, lazy: async () => ({ Component: (await import('./features/studio/CanvasListPage')).default }) },
      { path: 'studio/canvas/:canvasId', ...routeRecovery, lazy: async () => ({ Component: (await import('./features/studio/CanvasPage')).default }) },
      { path: 'studio/chat/:chatId?', ...routeRecovery, lazy: async () => ({ Component: (await import('./features/studio/ChatImagePage')).default }) },
      { path: 'studio/assets', ...routeRecovery, lazy: async () => ({ Component: (await import('./features/studio/AssetLibraryPage')).default }) },
      { path: 'studio/enhance', ...routeRecovery, lazy: async () => ({ Component: (await import('./features/studio/EnhanceWorkbenchPage')).default }) },
      { path: 'studio/angle', ...routeRecovery, lazy: async () => ({ Component: (await import('./features/studio/AnglePage')).default }) },
      { path: 'studio/gpt/:chatId?', ...routeRecovery, lazy: async () => ({ Component: (await import('./features/studio/GptChatPage')).default }) },
      { path: 'studio/prompts', ...routeRecovery, lazy: async () => ({ Component: (await import('./features/studio/PromptLibraryPage')).default }) },
      { path: 'studio/panorama', ...routeRecovery, lazy: async () => ({ Component: (await import('./features/studio/PanoramaPage')).default }) },
      { path: 'studio/grid', ...routeRecovery, lazy: async () => ({ Component: (await import('./features/studio/GridToolPage')).default }) },
      { path: 'studio/frames', ...routeRecovery, lazy: async () => ({ Component: (await import('./features/studio/FrameExtractorPage')).default }) },
      { path: 'studio/connectors', ...routeRecovery, lazy: async () => ({ Component: (await import('./features/studio/ConnectorSetupPage')).default }) },
      { path: 'studio/flows', ...routeRecovery, lazy: async () => ({ Component: (await import('./features/studio/FlowComposerPage')).default }) },
      { path: 'studio/models', ...routeRecovery, lazy: async () => ({ Component: (await import('./features/studio/ModelLabPage')).default }) },
      { path: 'studio/workflows', ...routeRecovery, lazy: async () => ({ Component: (await import('./features/studio/WorkflowCenterPage')).default }) },
      { path: 'studio/video', ...routeRecovery, lazy: async () => ({ Component: (await import('./features/studio/VideoDirectorPage')).default }) },
      { path: 'studio/zimage', ...routeRecovery, lazy: async () => ({ Component: (await import('./features/studio/ZImagePage')).default }) },
      { path: 'studio/online', ...routeRecovery, lazy: async () => ({ Component: (await import('./features/studio/OnlineImagePage')).default }) },
      { path: 'studio/klein', ...routeRecovery, lazy: async () => ({ Component: (await import('./features/studio/KleinPage')).default }) },
      { path: 'tasks', ...routeRecovery, lazy: async () => ({ Component: (await import('./features/studio/TaskCenterPage')).default }) },
      { path: 'accounts', ...routeRecovery, lazy: async () => ({ Component: (await import('./features/vault/VaultPage')).VaultPage }) },
      { path: 'mail', ...routeRecovery, lazy: async () => ({ Component: (await import('./features/mail/MailPage')).MailPage }) },
      { path: 'extensions', ...routeRecovery, lazy: async () => ({ Component: (await import('./features/extensions/ExtensionsPage')).ExtensionsPage }) },
      { path: 'video', ...routeRecovery, lazy: async () => ({ Component: (await import('./features/video/VideoLibraryPage')).VideoLibraryPage }) },
      { path: 'video/:videoId', ...routeRecovery, lazy: async () => ({ Component: (await import('./features/video/VideoLearnPage')).VideoLearnPage }) },
      { path: 'video/:videoId/pipeline', ...routeRecovery, lazy: async () => ({ Component: (await import('./features/pipeline/PipelinePage')).PipelinePage }) },
      { path: 'pipeline', ...routeRecovery, lazy: async () => ({ Component: (await import('./features/pipeline/PipelineCenterPage')).PipelineCenterPage }) },
      { path: 'pipeline/:domain', ...routeRecovery, lazy: async () => ({ Component: (await import('./features/pipeline/DomainPage')).DomainPage }) },
      { path: 'pipeline/:domain/:subjectId', ...routeRecovery, lazy: async () => ({ Component: (await import('./features/pipeline/SubjectDetailPage')).SubjectDetailPage }) },
      { path: 'talk', ...routeRecovery, lazy: async () => ({ Component: (await import('./features/talk/TalkScenariosPage')).TalkScenariosPage }) },
      { path: 'talk/session', ...routeRecovery, lazy: async () => ({ Component: (await import('./features/talk/TalkSessionPage')).TalkSessionPage }) },
      { path: 'settings/:section?', ...routeRecovery, lazy: async () => ({ Component: (await import('./features/settings/SettingsPage')).SettingsPage }) },
      { path: '*', ...routeRecovery, element: <Navigate to="/" replace /> },
    ],
  },
])

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
)
