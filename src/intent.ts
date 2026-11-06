export function xIntentUrl(text: string, quoteUrl?: string): string {
  const params = new URLSearchParams()
  if (text) params.set('text', text)
  if (quoteUrl) params.set('url', quoteUrl)
  const query = params.toString()
  return query ? `https://x.com/intent/post?${query}` : 'https://x.com/intent/post'
}
