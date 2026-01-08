const converter = new showdown.Converter()

async function runstream(){
    let prompt = document.querySelector("#question").value
    const fileInput = document.querySelector("#imageFile")   

    let response
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

    const reader = response.body.getReader()
    const decoder = new TextDecoder()

    let entireResponse = ""
    let buffer = ""
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
                if (chunkJson.response) entireResponse += chunkJson.response
            } catch (e) {
                // Ignore malformed partials; they will be retried when buffer completes.
                console.error("Failed to parse JSON line:", line, e)
            }
        }

        entireResponse = entireResponse.replace("<think>", `<div id="think">`)
        entireResponse = entireResponse.replace("</think>", `</div>`)
        let entireResponseAsHtml = converter.makeHtml(entireResponse)
        document.querySelector("#answer").innerHTML = entireResponseAsHtml
    }
    
    document.querySelector("#question").value = ""
}

async function run(){
    let prompt = document.querySelector("#question").value

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

    const reader = response.body.getReader()
    const decoder = new TextDecoder()

    let entireResponse = ""
    let buffer = ""
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
                if (chunkJson.response) entireResponse += chunkJson.response
            } catch (e) {
                console.error("Failed to parse JSON line:", line, e)
            }
        }

        entireResponse = entireResponse.replace("<think>", `<div id="think">`)
        entireResponse = entireResponse.replace("</think>", `</div>`)
        let entireResponseAsHtml = converter.makeHtml(entireResponse)
        document.querySelector("#answer").innerHTML = entireResponseAsHtml
    }
    
    document.querySelector("#question").value = ""
}

async function describeImage(){
    const fileInput = document.querySelector("#imageFile")
    const prompt = document.querySelector("#question").value

    if (!fileInput || !fileInput.files || fileInput.files.length === 0) {
        alert("Please choose an image first.")
        return
    }

    const form = new FormData()
    form.append("file", fileInput.files[0])
    form.append("prompt", prompt || "Describe this image.")
    form.append("max_new_tokens", "1024")

    const response = await fetch("/describeimage", {
        method: "POST",
        body: form,
    })

    if (!response.ok) {
        const text = await response.text()
        throw new Error(`Image describe failed: ${response.status} ${text}`)
    }

    const data = await response.json()
    const modelLine = data.model ? `**Model:** ${data.model}\n\n` : ""
    const captionLine = data.caption ? `**Caption:** ${data.caption}\n\n` : ""
    let entireResponse = `${modelLine}${captionLine}${data.response || ""}`

    entireResponse = entireResponse.replace("<think>", `<div id="think">`)
    entireResponse = entireResponse.replace("</think>", `</div>`)
    let entireResponseAsHtml = converter.makeHtml(entireResponse)
    document.querySelector("#answer").innerHTML = entireResponseAsHtml
}

// Make functions available to inline HTML onclick handlers.
window.run = run
window.runstream = runstream
window.describeImage = describeImage