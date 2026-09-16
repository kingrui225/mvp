'use client'

import { FormEvent, useEffect, useState } from 'react'
import { AtSign, ArrowLeft, ArrowRight, Camera, Check, Globe2, Search, Sparkles } from 'lucide-react'

const MAX_DESCRIPTION_LENGTH = 500

export default function Page() {
  const [website, setWebsite] = useState('')
  const [description, setDescription] = useState('')
  const [instagram, setInstagram] = useState('')
  const [inspirationLinks, setInspirationLinks] = useState('')
  const [step, setStep] = useState(1)
  const [searching, setSearching] = useState(false)
  const [resultsReady, setResultsReady] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')

  const inspirationItems = [
    ['@studioform', 'A quiet product story', 'from-[#d8e4df] via-[#b6c9c3] to-[#78938c]', 'aspect-[4/5]', 'calm product storytelling'],
    ['@northstar.co', 'Build in public', 'from-[#f0c9a8] via-[#d69072] to-[#8c4e4a]', 'aspect-[4/5]', 'founder behind the scenes'],
    ['@madebyfield', 'Details that matter', 'from-[#d5d8e8] via-[#a4a9c8] to-[#62698d]', 'aspect-[4/6]', 'educational design details'],
    ['@fwd.studio', 'The founder edit', 'from-[#e3d4bd] via-[#b9a17f] to-[#735f4d]', 'aspect-[4/5]', 'personal founder voice'],
    ['@formandfunction', 'A better carousel', 'from-[#cadbe8] via-[#8ca9bd] to-[#466273]', 'aspect-[4/6]', 'clear carousel format'],
    ['@ordinaryobjects', 'Make it memorable', 'from-[#e7cbd2] via-[#c4879a] to-[#713f58]', 'aspect-[4/5]', 'bold memorable brand'],
  ]

  const filteredInspirationItems = inspirationItems.filter((item) =>
    `${item[0]} ${item[1]} ${item[4]}`.toLowerCase().includes(searchQuery.toLowerCase()),
  )

  useEffect(() => {
    if (!searching) return
    const timer = window.setTimeout(() => {
      setSearching(false)
      setResultsReady(true)
    }, 2200)
    return () => window.clearTimeout(timer)
  }, [searching])

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (step === 1) {
      setStep(2)
      return
    }
    setSearching(true)
  }

  return (
    <main className={`min-h-screen text-[#17202b] ${resultsReady ? 'bg-[#f5f6f8]' : 'bg-[#f7f8fa] px-5 py-8 sm:px-8 sm:py-12'}`}>
      <div className={resultsReady ? 'flex min-h-screen flex-col' : 'mx-auto flex min-h-[calc(100vh-4rem)] max-w-3xl flex-col'}>
        <header className={`flex items-center justify-between ${resultsReady ? 'border-b border-[#e5e7eb] bg-white px-5 py-4 sm:px-8' : ''}`}>
          <div className="flex items-center gap-2.5">
            <div className="flex size-8 items-center justify-center rounded-xl bg-[#17202b] text-white shadow-sm">
              <Sparkles aria-hidden="true" className="size-4" />
            </div>
            <span className="text-sm font-semibold tracking-tight">Agenticfruit</span>
          </div>
          <span className="text-xs font-medium text-[#7a8593]">Company setup</span>
        </header>

        <div className={`${resultsReady ? 'hidden' : 'mt-12 flex items-center gap-3 sm:mt-16'}`}>
          <div className={`h-1.5 flex-1 rounded-full ${step >= 1 ? 'bg-[#17202b]' : 'bg-[#dfe4ea]'}`} />
          <div className={`h-1.5 flex-1 rounded-full ${step >= 2 ? 'bg-[#17202b]' : 'bg-[#dfe4ea]'}`} />
          <div className="h-1.5 flex-1 rounded-full bg-[#dfe4ea]" />
          <span className="ml-2 text-xs font-medium text-[#7a8593]">{step} of 3</span>
        </div>

        <section className={resultsReady ? 'flex min-h-0 flex-1 w-full flex-col' : 'mx-auto mt-10 w-full max-w-xl sm:mt-14'}>
          <div className="mb-8">
                      <h1 className="max-w-lg text-3xl font-semibold tracking-[-0.04em] text-[#17202b] sm:text-4xl">
              {step === 1 ? 'Tell us about your company.' : 'What inspires your content?'}
            </h1>
            <p className="mt-4 max-w-lg text-base leading-7 text-[#657180]">
              {step === 1 ? 'Share a few details so we can understand your brand and make your profile feel like you.' : 'Share Instagram carousels or Reels you like so we can understand the style you want to create.'}
            </p>
          </div>

          <div className="rounded-2xl border border-[#e1e5ea] bg-white p-6 shadow-[0_18px_50px_rgba(23,32,43,0.06)] sm:p-8">
            {searching ? (
              <div className="flex flex-col items-center py-12 text-center">
                <div className="relative flex size-16 items-center justify-center rounded-full bg-[#eef1f5]">
                  <div className="absolute inset-0 animate-spin rounded-full border-2 border-transparent border-t-[#17202b]" />
                  <Sparkles aria-hidden="true" className="size-6 text-[#17202b]" />
                </div>
                <h2 className="mt-6 text-xl font-semibold tracking-tight">Finding your creative references</h2>
                <p className="mt-2 max-w-sm text-sm leading-6 text-[#657180]">We&apos;re scanning Instagram for Reels and carousels that match your taste.</p>
                <div className="mt-7 flex gap-1.5" aria-label="Searching">
                  <span className="size-1.5 animate-pulse rounded-full bg-[#17202b]" />
                  <span className="size-1.5 animate-pulse rounded-full bg-[#17202b] [animation-delay:150ms]" />
                  <span className="size-1.5 animate-pulse rounded-full bg-[#17202b] [animation-delay:300ms]" />
                </div>
              </div>
            ) : resultsReady ? (
                <div className="flex min-h-0 flex-1 flex-col">
                  <div className="sticky top-0 z-10 border-b border-[#e7e9ed] bg-white/95 px-5 py-4 shadow-sm backdrop-blur sm:px-8">
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="flex items-center gap-2">
                        <div className="flex size-7 items-center justify-center rounded-full bg-gradient-to-br from-[#f9ce34] via-[#ee2a7b] to-[#6228d7] text-white"><Camera aria-hidden="true" className="size-3.5" /></div>
                        <h2 className="text-base font-semibold tracking-tight">Inspiration board</h2>
                      </div>
                      <p className="mt-1 text-xs text-[#7a8593]">Fresh references for your brand</p>
                    </div>
                    <button type="button" onClick={() => { setResultsReady(false); setStep(2) }} className="rounded-full border border-[#d9dfe6] px-3 py-1.5 text-xs font-semibold text-[#43505e] transition hover:bg-[#f7f8fa] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#17202b] focus-visible:ring-offset-2">Edit</button>
                  </div>
                  <div className="relative mt-4">
                    <Search aria-hidden="true" className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-[#8c97a4]" />
                    <input
                      aria-label="Search inspiration"
                      value={searchQuery}
                      onChange={(event) => setSearchQuery(event.target.value)}
                      placeholder="Describe the content you want to find..."
                      className="w-full rounded-xl border border-[#d9dfe6] bg-[#f8f9fb] py-3 pl-10 pr-4 text-sm text-[#17202b] outline-none transition placeholder:text-[#8994a1] focus:border-[#17202b] focus:bg-white focus:ring-2 focus:ring-[#17202b]/10"
                    />
                  </div>
                  <div className="mt-4 flex gap-5 overflow-x-auto pb-1">
                    {['Your brand', 'Visual identity', 'Storytelling', 'Product moments', 'Founder voice'].map((label, index) => (
                      <div key={label} className="flex shrink-0 flex-col items-center gap-1.5 text-center">
                        <div className={`flex size-12 items-center justify-center rounded-full p-[2px] ${index === 0 ? 'bg-[#17202b]' : 'bg-gradient-to-br from-[#f9ce34] via-[#ee2a7b] to-[#6228d7]'}`}><div className="flex size-full items-center justify-center rounded-full border-2 border-white bg-[#eef1f5] text-[10px] font-bold text-[#43505e]">{index === 0 ? 'You' : index === 1 ? '01' : index === 2 ? '02' : index === 3 ? '03' : '04'}</div></div>
                        <span className="max-w-16 truncate text-[10px] font-medium text-[#657180]">{label}</span>
                      </div>
                    ))}
                  </div>
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto bg-[#f5f6f8] px-3 py-4 sm:px-8 sm:py-6">
                  <div className="mx-auto max-w-6xl columns-2 gap-4 sm:columns-3 lg:columns-4">
                    {filteredInspirationItems.map(([handle, title, gradient, ratio]) => (
                      <a key={handle} href="#inspiration" className="group mb-4 block break-inside-avoid overflow-hidden rounded-2xl bg-white shadow-[0_1px_3px_rgba(23,32,43,0.08)] transition hover:-translate-y-0.5 hover:shadow-[0_8px_20px_rgba(23,32,43,0.12)]">
                        <div className={`relative flex ${ratio} items-end bg-gradient-to-br ${gradient} p-3`}><span className="absolute right-3 top-3 rounded-full bg-black/25 px-2 py-1 text-[10px] font-semibold text-white backdrop-blur-sm">{title.includes('carousel') ? 'Carousel' : 'Reel'}</span><div className="rounded-lg bg-black/20 p-2 text-white"><Sparkles aria-hidden="true" className="size-4" /></div></div>
                        <div className="flex items-center gap-2 px-3 py-2.5"><div className="flex size-6 items-center justify-center rounded-full bg-[#17202b] text-[8px] font-bold text-white">{handle.slice(1, 3).toUpperCase()}</div><span className="truncate text-[11px] font-semibold text-[#273442]">{handle}</span><span className="ml-auto text-[#a3acb7]">•••</span></div>
                      </a>
                    ))}
                  </div>
                </div>
              </div>
            ) : step === 1 ? (
              <form onSubmit={handleSubmit} className="flex flex-col gap-6">
                <div className="flex flex-col gap-2">
                  <label htmlFor="website" className="text-sm font-semibold text-[#273442]">
                    Company website <span className="text-[#bb4b4b]">*</span>
                  </label>
                  <div className="relative">
                    <Globe2 aria-hidden="true" className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-[#8c97a4]" />
                    <input
                      id="website"
                      name="website"
                      type="url"
                      required
                      value={website}
                      onChange={(event) => setWebsite(event.target.value)}
                      placeholder="https://yourcompany.com"
                      className="w-full rounded-lg border border-[#d9dfe6] bg-white py-3 pl-10 pr-3.5 text-sm text-[#17202b] outline-none transition placeholder:text-[#a3acb7] focus:border-[#17202b] focus:ring-2 focus:ring-[#17202b]/10"
                    />
                  </div>
                  <p className="text-xs text-[#8994a1]">Your public company or product website.</p>
                </div>

                <div className="flex flex-col gap-2">
                  <label htmlFor="description" className="text-sm font-semibold text-[#273442]">
                    What does your company do? <span className="text-[#bb4b4b]">*</span>
                  </label>
                  <textarea
                    id="description"
                    name="description"
                    required
                    maxLength={MAX_DESCRIPTION_LENGTH}
                    value={description}
                    onChange={(event) => setDescription(event.target.value)}
                    placeholder="Give us a short overview of your company, product, or mission."
                    rows={5}
                    className="w-full resize-none rounded-lg border border-[#d9dfe6] bg-white px-3.5 py-3 text-sm leading-6 text-[#17202b] outline-none transition placeholder:text-[#a3acb7] focus:border-[#17202b] focus:ring-2 focus:ring-[#17202b]/10"
                  />
                  <div className="flex justify-between gap-4 text-xs text-[#8994a1]">
                    <span>A sentence or two is perfect.</span>
                    <span>{description.length}/{MAX_DESCRIPTION_LENGTH}</span>
                  </div>
                </div>

                <div className="flex flex-col gap-2">
                  <label htmlFor="instagram" className="text-sm font-semibold text-[#273442]">
                    Instagram profile <span className="font-normal text-[#8994a1]">(optional)</span>
                  </label>
                  <div className="relative">
                    <AtSign aria-hidden="true" className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-[#8c97a4]" />
                    <input
                      id="instagram"
                      name="instagram"
                      type="text"
                      value={instagram}
                      onChange={(event) => setInstagram(event.target.value)}
                      placeholder="@yourcompany"
                      className="w-full rounded-lg border border-[#d9dfe6] bg-white py-3 pl-10 pr-3.5 text-sm text-[#17202b] outline-none transition placeholder:text-[#a3acb7] focus:border-[#17202b] focus:ring-2 focus:ring-[#17202b]/10"
                    />
                  </div>
                  <p className="text-xs text-[#8994a1]">Add a handle or full Instagram profile link.</p>
                </div>

                <div className="mt-1 flex flex-col-reverse gap-3 border-t border-[#edf0f3] pt-6 sm:flex-row sm:items-center sm:justify-between">
                  <button
                    type="button"
                    className="rounded-lg px-4 py-2.5 text-sm font-semibold text-[#657180] transition hover:bg-[#f7f8fa] hover:text-[#17202b] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#17202b] focus-visible:ring-offset-2"
                  >
                    Skip for now
                  </button>
                  <button
                    type="submit"
                    className="inline-flex items-center justify-center gap-2 rounded-lg bg-[#17202b] px-5 py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-[#2b3948] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#17202b] focus-visible:ring-offset-2"
                  >
                    Continue
                    <ArrowRight aria-hidden="true" className="size-4" />
                  </button>
                </div>
              </form>
            ) : (
              <form onSubmit={handleSubmit} className="flex flex-col gap-6">
                <div className="flex flex-col gap-2">
                  <label htmlFor="inspiration-links" className="text-sm font-semibold text-[#273442]">
                    Instagram inspiration <span className="font-normal text-[#8994a1]">(optional)</span>
                  </label>
                  <div className="relative">
                    <Camera aria-hidden="true" className="pointer-events-none absolute left-3.5 top-3.5 size-4 text-[#8c97a4]" />
                    <textarea
                      id="inspiration-links"
                      name="inspiration-links"
                      value={inspirationLinks}
                      onChange={(event) => setInspirationLinks(event.target.value)}
                      placeholder="https://instagram.com/p/...\nhttps://instagram.com/reel/..."
                      rows={6}
                      className="w-full resize-none rounded-lg border border-[#d9dfe6] bg-white px-3.5 py-3 pl-10 text-sm leading-6 text-[#17202b] outline-none transition placeholder:text-[#a3acb7] focus:border-[#17202b] focus:ring-2 focus:ring-[#17202b]/10"
                    />
                  </div>
                  <p className="text-xs leading-5 text-[#8994a1]">Add one or more links, separated by a new line. Reels and carousels both work.</p>
                </div>

                <div className="rounded-lg bg-[#f7f8fa] px-4 py-3 text-sm leading-6 text-[#657180]">
                  Not sure yet? You can skip this step and add inspiration later.
                </div>

                <div className="mt-1 flex flex-col-reverse gap-3 border-t border-[#edf0f3] pt-6 sm:flex-row sm:items-center sm:justify-between">
                  <button
                    type="button"
                    onClick={() => setStep(1)}
                    className="inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm font-semibold text-[#657180] transition hover:bg-[#f7f8fa] hover:text-[#17202b] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#17202b] focus-visible:ring-offset-2"
                  >
                    <ArrowLeft aria-hidden="true" className="size-4" />
                    Back
                  </button>
                  <button
                    type="submit"
                    className="inline-flex items-center justify-center gap-2 rounded-lg bg-[#17202b] px-5 py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-[#2b3948] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#17202b] focus-visible:ring-offset-2"
                  >
                    Finish setup
                    <Check aria-hidden="true" className="size-4" />
                  </button>
                </div>
              </form>
            )}
          </div>
          <p className="mt-5 text-center text-xs text-[#8994a1]">You can update these details anytime.</p>
        </section>
      </div>
    </main>
  )
}

