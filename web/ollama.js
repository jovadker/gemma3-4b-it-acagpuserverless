const converter = new showdown.Converter()

let isBusy = false

function getUi(){
    return {
        question: document.querySelector("#question"),
        imageFile: document.querySelector("#imageFile"),
        answer: document.querySelector("#answer"),
        spinner: document.querySelector("#spinner"),
        statusText: document.querySelector("#statusText"),
        buttons: [
            document.querySelector("#btnAsk"),
            document.querySelector("#btnAskStream"),
            document.querySelector("#btnDescribeImage"),
        ].filter(Boolean),
    }
}

function setBusy(busy, statusText = ""){
    isBusy = busy
    const ui = getUi()

    for (const btn of ui.buttons) {
        btn.disabled = busy
    }
    if (ui.question) ui.question.disabled = busy
    if (ui.imageFile) ui.imageFile.disabled = busy

    if (ui.statusText) ui.statusText.textContent = statusText
}

function showSpinner(show){
    const ui = getUi()
    if (!ui.spinner) return
    ui.spinner.classList.toggle("is-active", Boolean(show))
}

function renderMarkdownIntoAnswer(markdownText){
    let rendered = markdownText
    rendered = rendered.replace("<think>", `<div id=\"think\">`)
    rendered = rendered.replace("</think>", `</div>`)
    const html = converter.makeHtml(rendered)
    const ui = getUi()
    if (ui.answer) ui.answer.innerHTML = html
}

function renderError(message){
    const ui = getUi()
    if (!ui.answer) return
    const safe = String(message || "Request failed")
    ui.answer.textContent = safe
}

async function runstream(){
    if (isBusy) return

    const ui = getUi()
    const prompt = ui.question ? ui.question.value : ""
    const fileInput = ui.imageFile

    setBusy(true, "Generating…")
    showSpinner(true)

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

            renderMarkdownIntoAnswer(entireResponse)
        }

        if (ui.question) ui.question.value = ""
    } catch (err) {
        showSpinner(false)
        setBusy(true, "")
        renderError(err && err.message ? err.message : String(err))
    } finally {
        showSpinner(false)
        setBusy(false, "")
    }
}

async function run(){
    if (isBusy) return

    const ui = getUi()
    const prompt = ui.question ? ui.question.value : ""

    setBusy(true, "Generating…")
    showSpinner(true)

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

            renderMarkdownIntoAnswer(entireResponse)
        }
        if (ui.question) ui.question.value = ""
    } catch (err) {
        showSpinner(false)
        setBusy(true, "")
        renderError(err && err.message ? err.message : String(err))
    } finally {
        showSpinner(false)
        setBusy(false, "")
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

    const form = new FormData()
    form.append("file", fileInput.files[0])
    form.append("prompt", prompt || "Describe this image.")
    form.append("max_new_tokens", "1024")

    try {
        const response = await fetch("/describeimage", {
            method: "POST",
            body: form,
        })

        if (!response.ok) {
            const text = await response.text().catch(() => "")
            throw new Error(`Image describe failed: ${response.status} ${text}`)
        }

        const data = await response.json()
        const modelLine = data.model ? `**Model:** ${data.model}\n\n` : ""
        const captionLine = data.caption ? `**Caption:** ${data.caption}\n\n` : ""
        const entireResponse = `${modelLine}${captionLine}${data.response || ""}`
        renderMarkdownIntoAnswer(entireResponse)
    } catch (err) {
        renderError(err && err.message ? err.message : String(err))
    } finally {
        showSpinner(false)
        setBusy(false, "")
    }
}

// Make functions available to inline HTML onclick handlers.
window.run = run
window.runstream = runstream
window.describeImage = describeImage