const converter = new showdown.Converter()

let isBusy = false
const MIN_SPINNER_MS = 500
const MAX_NEW_TOKEN = 768
let spinnerShownAtMs = 0
let spinnerHideTimer = null
let imagePreviewObjectUrls = []

let statusBaseText = ""
let statusTicker = null
let statusTickerStartedAtMs = 0

function getUi(){
    return {
        question: document.querySelector("#question"),
        imageFile: document.querySelector("#imageFile"),
        answer: document.querySelector("#answer"),
        spinner: document.querySelector("#spinner"),
        statusText: document.querySelector("#statusText"),
        scaleEndpoint: document.querySelector("#scaleEndpoint"),
        scaleRequests: document.querySelector("#scaleRequests"),
        scaleConcurrency: document.querySelector("#scaleConcurrency"),
        imagePreview: document.querySelector("#imagePreview"),
        imagePreviewThumbs: document.querySelector("#imagePreviewThumbs"),
        imagePreviewCount: document.querySelector("#imagePreviewCount"),
        imagePreviewNames: document.querySelector("#imagePreviewNames"),
        buttons: [
            document.querySelector("#btnAsk"),
            document.querySelector("#btnAskStream"),
            document.querySelector("#btnDescribeImage"),
            document.querySelector("#btnDescribeImagesBatch"),
            document.querySelector("#btnScaleTest"),
        ].filter(Boolean),
    }
}

function _pct(values, p){
    if (!values || values.length === 0) return 0
    const s = [...values].sort((a, b) => a - b)
    const k = Math.max(0, Math.min(s.length - 1, Math.round((s.length - 1) * p)))
    return s[k]
}

async function _consumeStreamToEnd(response){
    // Drain a streaming endpoint so the server can finish the request.
    await streamNdjson(response, async () => {})
}

async function runScaleTest(){
    if (isBusy) return

    const ui = getUi()
    const fileInput = ui.imageFile
    const files = fileInput && fileInput.files ? Array.from(fileInput.files) : []

    if (files.length === 0) {
        alert("Please choose one or more images first.")
        return
    }

    const endpoint = ui.scaleEndpoint ? ui.scaleEndpoint.value : "/describeimagebatch"
    const totalRequests = ui.scaleRequests ? parseInt(ui.scaleRequests.value || "10", 10) : 10
    const concurrency = ui.scaleConcurrency ? parseInt(ui.scaleConcurrency.value || "10", 10) : 10

    const N = Number.isFinite(totalRequests) ? Math.max(1, Math.min(500, totalRequests)) : 10
    const C = Number.isFinite(concurrency) ? Math.max(1, Math.min(100, concurrency)) : 10

    const prompt = ui.question ? ui.question.value : ""

    setBusy(true, `Scale test: ${N} req @ ${C} conc…`)
    showSpinner(true)
    startStatusTicker()

    const semaphore = { count: C }
    const queue = []
    const take = async () => {
        while (semaphore.count <= 0) {
            await new Promise(r => queue.push(r))
        }
        semaphore.count -= 1
    }
    const give = () => {
        semaphore.count += 1
        const next = queue.shift()
        if (next) next()
    }

    const nowMs = () => (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now()

    try {
        const results = new Array(N).fill(null)
        const startedAll = nowMs()

        const one = async (i) => {
            await take()
            try {
                const started = nowMs()

                const form = new FormData()
                const maxTokens = "128"

                if (endpoint === "/describeimage") {
                    form.append("file", files[0])
                    form.append("prompt", prompt || "Describe this image.")
                    form.append("max_new_tokens", maxTokens)
                } else {
                    for (const f of files) form.append("files", f)
                    form.append("prompt", prompt || "Describe these images.")
                    form.append("max_new_tokens", maxTokens)
                }

                const resp = await fetch(endpoint, { method: "POST", body: form })
                const instanceId = resp.headers.get("x-instance-id") || "(unknown)"

                if (!resp.ok) {
                    const text = await resp.text().catch(() => "")
                    results[i] = {
                        ok: false,
                        ms: Math.max(0, Math.round(nowMs() - started)),
                        status: resp.status,
                        instanceId,
                        error: (text || "").slice(0, 300),
                    }
                    return
                }

                if (endpoint === "/describeimagebatchstream") {
                    await _consumeStreamToEnd(resp)
                } else {
                    await resp.json().catch(() => null)
                }

                results[i] = {
                    ok: true,
                    ms: Math.max(0, Math.round(nowMs() - started)),
                    status: resp.status,
                    instanceId,
                }
            } catch (e) {
                results[i] = {
                    ok: false,
                    ms: 0,
                    status: 0,
                    instanceId: "(unknown)",
                    error: e && e.message ? e.message : String(e),
                }
            } finally {
                give()
            }
        }

        await Promise.all(Array.from({ length: N }, (_, i) => one(i)))
        const totalMs = Math.max(0, Math.round(nowMs() - startedAll))

        const ok = results.filter(r => r && r.ok)
        const failed = results.filter(r => r && !r.ok)
        const lats = results.map(r => (r ? r.ms : 0)).filter(ms => ms > 0)

        const byInstance = new Map()
        for (const r of ok) {
            const key = r.instanceId || "(unknown)"
            byInstance.set(key, (byInstance.get(key) || 0) + 1)
        }

        let md = `## ACA scale test\n\n`
        md += `**Endpoint:** ${endpoint}\n\n`
        md += `**Requests:** ${N}  **Concurrency:** ${C}  **Images/request:** ${files.length}\n\n`
        md += `**Succeeded:** ${ok.length}  **Failed:** ${failed.length}  **Total:** ${totalMs}ms\n\n`

        if (lats.length > 0) {
            md += `**Latency (ms):** min ${Math.min(...lats)} | p50 ${_pct(lats, 0.50)} | p90 ${_pct(lats, 0.90)} | p99 ${_pct(lats, 0.99)} | max ${Math.max(...lats)}\n\n`
        }

        md += `### Instances (from x-instance-id)\n\n`
        md += `| instance | ok requests |\n|:--|--:|\n`
        for (const [instance, count] of [...byInstance.entries()].sort((a, b) => b[1] - a[1])) {
            md += `| ${instance} | ${count} |\n`
        }

        if (failed.length > 0) {
            md += `\n### Failures\n\n`
            md += `| # | status | instance | error |\n|---:|---:|:--|:--|\n`
            for (let i = 0; i < failed.length; i++) {
                const r = failed[i]
                const err = String(r.error || "").replace(/\r?\n/g, " ").trim()
                md += `| ${i + 1} | ${r.status || 0} | ${r.instanceId || "(unknown)"} | ${err} |\n`
            }
        }

        renderMarkdownIntoAnswer(md)
    } catch (err) {
        renderError(err && err.message ? err.message : String(err))
    } finally {
        setBusy(false, "")
        showSpinner(false)
    }
}

function clearImagePreview(){
    const ui = getUi()

    for (const url of imagePreviewObjectUrls) {
        try { URL.revokeObjectURL(url) } catch { /* ignore */ }
    }
    imagePreviewObjectUrls = []

    if (ui.imagePreviewThumbs) ui.imagePreviewThumbs.innerHTML = ""
    if (ui.imagePreviewCount) ui.imagePreviewCount.textContent = ""
    if (ui.imagePreviewNames) ui.imagePreviewNames.textContent = ""
    if (ui.imagePreview) {
        ui.imagePreview.classList.add("is-hidden")
        ui.imagePreview.setAttribute("aria-hidden", "true")
    }
}

function updateImagePreviewFromInput(){
    const ui = getUi()
    const fileInput = ui.imageFile

    const files = fileInput && fileInput.files ? Array.from(fileInput.files) : []
    if (files.length === 0) {
        clearImagePreview()
        return
    }

    // Clear prior previews + URLs
    clearImagePreview()

    const maxThumbs = 5
    const thumbs = files.slice(0, maxThumbs)
    for (const file of thumbs) {
        const url = URL.createObjectURL(file)
        imagePreviewObjectUrls.push(url)
        if (ui.imagePreviewThumbs) {
            const img = document.createElement("img")
            img.src = url
            img.alt = file.name
            ui.imagePreviewThumbs.appendChild(img)
        }
    }

    if (ui.imagePreviewCount) {
        ui.imagePreviewCount.textContent = files.length === 1 ? "1 image selected" : `${files.length} images selected`
    }
    if (ui.imagePreviewNames) {
        // Keep it concise; the file input already shows the first name.
        const names = files.map(f => f.name)
        ui.imagePreviewNames.textContent = names.join(", ")
    }
    if (ui.imagePreview) {
        ui.imagePreview.classList.remove("is-hidden")
        ui.imagePreview.setAttribute("aria-hidden", "false")
    }
}

function initUiHandlers(){
    const ui = getUi()
    if (ui.imageFile) {
        ui.imageFile.addEventListener("change", updateImagePreviewFromInput)
    }
    // Initialize preview state if the browser restores a chosen file.
    updateImagePreviewFromInput()
}

function setBusy(busy, statusText = ""){
    isBusy = busy
    const ui = getUi()

    for (const btn of ui.buttons) {
        btn.disabled = busy
    }
    if (ui.question) ui.question.disabled = busy
    if (ui.imageFile) ui.imageFile.disabled = busy

    // Only update status text when explicitly provided.
    if (statusText !== undefined && statusText !== null) {
        statusBaseText = String(statusText)
        if (ui.statusText) ui.statusText.textContent = statusText
    }

    if (!busy) {
        stopStatusTicker()
        statusBaseText = ""
        // Always clear status when generation finishes.
        if (ui.statusText) ui.statusText.textContent = ""
    }
}

function startStatusTicker(){
    stopStatusTicker()
    const ui = getUi()
    if (!ui.statusText) return
    statusTickerStartedAtMs = Date.now()
    statusTicker = setInterval(() => {
        if (!isBusy) return
        const elapsedSec = Math.max(0, Math.floor((Date.now() - statusTickerStartedAtMs) / 1000))
        const base = statusBaseText || "Generating…"
        ui.statusText.textContent = elapsedSec > 0 ? `${base} (${elapsedSec}s)` : base
    }, 500)
}

function stopStatusTicker(){
    if (statusTicker) {
        clearInterval(statusTicker)
        statusTicker = null
    }
}

function showSpinner(show){
    const ui = getUi()
    if (!ui.spinner) return

    if (show) {
        if (spinnerHideTimer) {
            clearTimeout(spinnerHideTimer)
            spinnerHideTimer = null
        }
        spinnerShownAtMs = Date.now()
        ui.spinner.classList.add("is-active")
        return
    }

    const elapsed = Date.now() - spinnerShownAtMs
    const remaining = Math.max(0, MIN_SPINNER_MS - elapsed)

    const hide = () => {
        spinnerHideTimer = null
        ui.spinner.classList.remove("is-active")
        // If generation already finished, clear the status text when the spinner disappears.
        if (!isBusy && ui.statusText) ui.statusText.textContent = ""
    }

    if (spinnerHideTimer) {
        clearTimeout(spinnerHideTimer)
        spinnerHideTimer = null
    }

    if (remaining === 0) {
        hide()
    } else {
        spinnerHideTimer = setTimeout(hide, remaining)
    }
}

function renderMarkdownIntoAnswer(markdownText){
    let rendered = markdownText
    rendered = rendered.replace("<think>", `<div id=\"think\">`)
    rendered = rendered.replace("</think>", `</div>`)
    const html = converter.makeHtml(rendered)
    const ui = getUi()
    if (ui.answer) ui.answer.innerHTML = html
}

// Converting Markdown->HTML for every streamed token is expensive.
// Throttle rendering to keep the UI responsive.
const RENDER_THROTTLE_MS = 80
let renderTimer = null
let latestMarkdownForRender = ""

function renderMarkdownIntoAnswerThrottled(markdownText, flush = false){
    latestMarkdownForRender = markdownText

    if (flush) {
        if (renderTimer) {
            clearTimeout(renderTimer)
            renderTimer = null
        }
        renderMarkdownIntoAnswer(latestMarkdownForRender)
        return
    }

    if (renderTimer) return
    renderTimer = setTimeout(() => {
        renderTimer = null
        renderMarkdownIntoAnswer(latestMarkdownForRender)
    }, RENDER_THROTTLE_MS)
}

function renderError(message){
    const ui = getUi()
    if (!ui.answer) return
    const safe = String(message || "Request failed")
    ui.answer.textContent = safe
}

async function streamNdjson(response, onJson){
    if (!response.body) throw new Error("No response body")
    const reader = response.body.getReader()
    const decoder = new TextDecoder()

    let buffer = ""
    while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })

        const lines = buffer.split(/\r?\n/)
        buffer = lines.pop() ?? ""

        for (let line of lines) {
            line = line.trim()
            if (!line) continue
            if (line.startsWith("data:")) line = line.slice("data:".length).trim()
            if (!line) continue
            try {
                const json = JSON.parse(line)
                await onJson(json)
            } catch (e) {
                // Ignore malformed partials; they will be retried when buffer completes.
                console.error("Failed to parse JSON line:", line, e)
            }
        }
    }
}

async function describeImagesStreamBatch(files, prompt){
    const ui = getUi()

    setBusy(true, `Generating 1/${files.length}…`)
    showSpinner(true)
    startStatusTicker()

    const perFileText = new Array(files.length).fill("")
    let gotFirstToken = false

    const rebuildMarkdown = () => {
        let markdown = ""
        for (let i = 0; i < files.length; i++) {
            const name = files[i]?.name || `(image ${i + 1})`
            markdown += `### ${name}\n\n${perFileText[i] || ""}\n\n`
        }
        renderMarkdownIntoAnswerThrottled(markdown)
    }

    try {
        for (let i = 0; i < files.length; i++) {
            const file = files[i]
            setBusy(true, `Generating ${i + 1}/${files.length}…`)

            const form = new FormData()
            form.append("file", file)
            form.append("prompt", prompt || "Describe this image.")
            form.append("max_new_tokens", "1024")

            const response = await fetch("/describeimagestream", {
                method: "POST",
                body: form,
            })

            if (!response.ok) {
                const text = await response.text().catch(() => "")
                perFileText[i] = `**Error:** ${response.status} ${text}`
                rebuildMarkdown()
                continue
            }

            await streamNdjson(response, async (chunkJson) => {
                if (chunkJson.error) {
                    perFileText[i] += `\n\n**Error:** ${chunkJson.error}`
                    rebuildMarkdown()
                    return
                }
                if (chunkJson.response) {
                    perFileText[i] += chunkJson.response
                    if (!gotFirstToken) {
                        gotFirstToken = true
                        showSpinner(false)
                    }
                    rebuildMarkdown()
                }
            })
        }

        // Ensure final render is not throttled away.
        {
            let finalMarkdown = ""
            for (let i = 0; i < files.length; i++) {
                const name = files[i]?.name || `(image ${i + 1})`
                finalMarkdown += `### ${name}\n\n${perFileText[i] || ""}\n\n`
            }
            renderMarkdownIntoAnswerThrottled(finalMarkdown, true)
        }

        if (ui.question) ui.question.value = ""
    } catch (err) {
        renderError(err && err.message ? err.message : String(err))
    } finally {
        setBusy(false, "")
        showSpinner(false)
    }
}

async function runstream(){
    if (isBusy) return

    const ui = getUi()
    const prompt = ui.question ? ui.question.value : ""
    const fileInput = ui.imageFile

    // If multiple images are selected, stream each image sequentially.
    if (fileInput && fileInput.files && fileInput.files.length > 1) {
        const files = Array.from(fileInput.files)
        return describeImagesStreamBatch(files, prompt)
    }

    setBusy(true, "Generating…")
    showSpinner(true)
    startStatusTicker()

    let response
    try {
        if (fileInput && fileInput.files && fileInput.files.length > 0) {
            const form = new FormData()
            form.append("file", fileInput.files[0])
            form.append("prompt", prompt || "Describe this image.")
            form.append("max_new_tokens", "1024")

            response = await fetch("/describeimagestream", {
                method: "POST",
                body: form,
            })
        } else {
            response = await fetch("/predictstream", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Access-Control-Allow-Origin": "*",
                },
                body: JSON.stringify({
                    prompt: prompt,
                    stream: true
                })
            })
        }

        if (!response.ok) {
            const text = await response.text().catch(() => "")
            throw new Error(`Request failed: ${response.status} ${text}`)
        }
        if (!response.body) {
            throw new Error("No response body")
        }

        const reader = response.body.getReader()
        const decoder = new TextDecoder()

        let entireResponse = ""
        let buffer = ""
        let gotFirstToken = false
        while (true) {
            const { done, value } = await reader.read();
            if (done) break
            buffer += decoder.decode(value, { stream: true })

            // Parse newline-delimited JSON objects. Also tolerate SSE-style lines: "data: {...}".
            const lines = buffer.split(/\r?\n/)
            buffer = lines.pop() ?? ""
            for (let line of lines) {
                line = line.trim()
                if (!line) continue
                if (line.startsWith("data:")) line = line.slice("data:".length).trim()
                if (!line) continue
                try {
                    const chunkJson = JSON.parse(line)
                    if (chunkJson.error) {
                        throw new Error(chunkJson.error)
                    }
                    if (chunkJson.response) {
                        entireResponse += chunkJson.response
                        if (!gotFirstToken) {
                            gotFirstToken = true
                            showSpinner(false)
                            // Keep status text ("Generating…") until completion.
                        }
                    }
                } catch (e) {
                    // Ignore malformed partials; they will be retried when buffer completes.
                    console.error("Failed to parse JSON line:", line, e)
                }
            }

            renderMarkdownIntoAnswerThrottled(entireResponse)
        }

        renderMarkdownIntoAnswerThrottled(entireResponse, true)

        if (ui.question) ui.question.value = ""
    } catch (err) {
        renderError(err && err.message ? err.message : String(err))
    } finally {
        // Re-enable controls immediately, but keep status/spinner visible until spinner hides.
        setBusy(false, "")
        showSpinner(false)
    }
}

async function run(){
    if (isBusy) return

    const ui = getUi()
    const prompt = ui.question ? ui.question.value : ""

    setBusy(true, "Generating…")
    showSpinner(true)
    startStatusTicker()

    try {
        const response = await fetch("/predict", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Access-Control-Allow-Origin": "*",
            },
            body: JSON.stringify({
                prompt: prompt,
                stream: true
            })
        })

        if (!response.ok) {
            const text = await response.text().catch(() => "")
            throw new Error(`Request failed: ${response.status} ${text}`)
        }
        if (!response.body) {
            throw new Error("No response body")
        }

        const reader = response.body.getReader()
        const decoder = new TextDecoder()

        let entireResponse = ""
        let buffer = ""
        let gotFirstToken = false
        while (true) {
            const { done, value } = await reader.read();
            if (done) break
            buffer += decoder.decode(value, { stream: true })

            const lines = buffer.split(/\r?\n/)
            buffer = lines.pop() ?? ""
            for (let line of lines) {
                line = line.trim()
                if (!line) continue
                if (line.startsWith("data:")) line = line.slice("data:".length).trim()
                if (!line) continue
                try {
                    const chunkJson = JSON.parse(line)
                    if (chunkJson.error) {
                        throw new Error(chunkJson.error)
                    }
                    if (chunkJson.response) {
                        entireResponse += chunkJson.response
                        if (!gotFirstToken) {
                            gotFirstToken = true
                            showSpinner(false)
                            // Keep status text ("Generating…") until completion.
                        }
                    }
                } catch (e) {
                    console.error("Failed to parse JSON line:", line, e)
                }
            }

            renderMarkdownIntoAnswerThrottled(entireResponse)
        }
        renderMarkdownIntoAnswerThrottled(entireResponse, true)
        if (ui.question) ui.question.value = ""
    } catch (err) {
        renderError(err && err.message ? err.message : String(err))
    } finally {
        setBusy(false, "")
        showSpinner(false)
    }
}

async function describeImage(){
    if (isBusy) return

    const ui = getUi()
    const fileInput = ui.imageFile
    const prompt = ui.question ? ui.question.value : ""

    if (!fileInput || !fileInput.files || fileInput.files.length === 0) {
        alert("Please choose an image first.")
        return
    }

    setBusy(true, "Generating…")
    showSpinner(true)
    startStatusTicker()

    try {
        const files = Array.from(fileInput.files)
        let markdown = ""

        // Prefer a single backend request when analyzing multiple images.
        if (files.length > 1) {
            setBusy(true, `Generating 1/${files.length}…`)

            const form = new FormData()
            for (const file of files) form.append("files", file)
            form.append("prompt", prompt || "Describe these images.")
            // Batch (non-stream) should default smaller to keep latency reasonable.
            form.append("max_new_tokens", MAX_NEW_TOKEN.toString())

            const response = await fetch("/describeimagebatch", {
                method: "POST",
                body: form,
            })

            if (!response.ok) {
                const text = await response.text().catch(() => "")
                throw new Error(`Batch describe failed: ${response.status} ${text}`)
            }

            const data = await response.json()
            const results = Array.isArray(data.results) ? data.results : []
            for (const r of results) {
                const name = r && r.filename ? r.filename : "(unknown file)"
                const header = `### ${name}\n\n`
                if (r && r.error) {
                    markdown += `${header}**Error:** ${r.error}\n\n`
                } else {
                    markdown += `${header}${(r && r.response) ? r.response : ""}\n\n`
                }
            }
            renderMarkdownIntoAnswer(markdown)
            return
        }

        // Single image: keep the existing /describeimage call.
        const file = files[0]
        const form = new FormData()
        form.append("file", file)
        form.append("prompt", prompt || "Describe this image.")
        form.append("max_new_tokens", "1024")

        const response = await fetch("/describeimage", {
            method: "POST",
            body: form,
        })

        if (!response.ok) {
            const text = await response.text().catch(() => "")
            throw new Error(`Image describe failed: ${response.status} ${text}`)
        }

        const single = await response.json()
        const modelLine = single.model ? `**Model:** ${single.model}\n\n` : ""
        const entireResponse = `${modelLine}${single.response || ""}`
        renderMarkdownIntoAnswer(entireResponse)
    } catch (err) {
        renderError(err && err.message ? err.message : String(err))
    } finally {
        setBusy(false, "")
        showSpinner(false)
    }
}

async function describeImagesBatch(){
    if (isBusy) return

    const ui = getUi()
    const fileInput = ui.imageFile
    const prompt = ui.question ? ui.question.value : ""

    const files = fileInput && fileInput.files ? Array.from(fileInput.files) : []
    if (files.length === 0) {
        alert("Please choose one or more images first.")
        return
    }
    if (files.length === 1) {
        // Keep UX simple: the existing single-image button already does the right thing.
        return describeImage()
    }

    setBusy(true, `Generating 1/${files.length}…`)
    showSpinner(true)
    startStatusTicker()

    try {
        const form = new FormData()
        for (const file of files) form.append("files", file)
        form.append("prompt", prompt || "Describe these images.")
        // Keep batch latency reasonable; users can switch to streaming for longer outputs.
        form.append("max_new_tokens", "512")

        const response = await fetch("/describeimagebatchstream", {
            method: "POST",
            body: form,
        })

        if (!response.ok) {
            const text = await response.text().catch(() => "")
            throw new Error(`Batch describe stream failed: ${response.status} ${text}`)
        }

        const perFileText = new Array(files.length).fill("")
        const perFileName = files.map(f => f.name)

        const rebuild = (flush = false) => {
            let markdown = ""
            for (let i = 0; i < perFileName.length; i++) {
                const name = perFileName[i] || `(image ${i + 1})`
                markdown += `### ${name}\n\n${perFileText[i] || ""}\n\n`
            }
            renderMarkdownIntoAnswerThrottled(markdown, flush)
        }

        await streamNdjson(response, async (evt) => {
            if (!evt || !evt.type) return
            if (evt.type === "meta") {
                return
            }
            if (evt.type === "progress") {
                if (typeof evt.index === "number") {
                    setBusy(true, `Generating ${evt.index + 1}/${files.length}…`)
                }
                return
            }
            if (evt.type === "result") {
                const idx = typeof evt.index === "number" ? evt.index : -1
                if (idx >= 0 && idx < perFileText.length) {
                    if (evt.filename && perFileName[idx] !== evt.filename) {
                        perFileName[idx] = evt.filename
                    }
                    if (evt.error) {
                        perFileText[idx] = `**Error:** ${evt.error}`
                    } else {
                        perFileText[idx] = evt.response || ""
                    }
                    rebuild()
                }
                return
            }
            if (evt.type === "done") {
                rebuild(true)
            }
        })

        rebuild(true)
        if (ui.question) ui.question.value = ""
    } catch (err) {
        renderError(err && err.message ? err.message : String(err))
    } finally {
        setBusy(false, "")
        showSpinner(false)
    }
}

// Make functions available to inline HTML onclick handlers.
window.run = run
window.runstream = runstream
window.describeImage = describeImage
window.describeImagesBatch = describeImagesBatch
window.runScaleTest = runScaleTest

document.addEventListener("DOMContentLoaded", initUiHandlers)