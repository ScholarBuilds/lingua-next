const NAV_HOSTS = new Set(['www.youtube.com', 'youtube.com', 'm.youtube.com', 'youtu.be'])
const RESOURCE_DOMAINS = ['youtube.com', 'youtube-nocookie.com', 'googlevideo.com', 'ytimg.com', 'ggpht.com', 'gstatic.com', 'google.com', 'googleapis.com', 'doubleclick.net']

export function youtubeNavigation(input: string): string | null {
  try {
    const url = new URL(input)
    if (url.protocol !== 'https:' || url.username || url.password || url.port || !NAV_HOSTS.has(url.hostname)) return null
    return url.href
  } catch { return null }
}

export function youtubeResource(input: string): boolean {
  try {
    const url = new URL(input)
    return url.protocol === 'https:' && !url.port && !url.username && !url.password
      && RESOURCE_DOMAINS.some(domain => url.hostname === domain || url.hostname.endsWith(`.${domain}`))
  } catch { return false }
}
