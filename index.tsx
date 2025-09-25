/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
import { GoogleGenAI, Type } from "@google/genai";

// Let TS know that JSZip will be available on the window.
declare var JSZip: any;

// --- DOM ELEMENT REFERENCES ---
const form = document.getElementById('prompt-form') as HTMLFormElement;
const input = document.getElementById('prompt-input') as HTMLTextAreaElement;
const generateBtn = document.getElementById('generate-btn') as HTMLButtonElement;
const loadingContainer = document.getElementById('loading-container') as HTMLDivElement;
const loadingText = document.getElementById('loading-text') as HTMLParagraphElement;
const resultContainer = document.getElementById('result-container') as HTMLDivElement;
const inputSection = document.getElementById('input-section') as HTMLDivElement;

const pageTypeSelect = document.getElementById('page-type') as HTMLSelectElement;
const imageCountInput = document.getElementById('image-count') as HTMLInputElement;
const sectionCheckboxes = document.querySelectorAll<HTMLInputElement>('#section-checkboxes input[type="checkbox"]');

const tabs = document.querySelector('.tabs') as HTMLDivElement;
const tabButtons = document.querySelectorAll('.tab-button');
// FIX: Specify HTMLElement for querySelectorAll to ensure 'hidden' property is available on iterated elements.
const tabContents = document.querySelectorAll<HTMLElement>('.tab-content');

const previewFrame = document.getElementById('preview-frame') as HTMLIFrameElement;
const htmlEditor = document.getElementById('html-editor') as HTMLTextAreaElement;
const cssEditor = document.getElementById('css-editor') as HTMLTextAreaElement;
const updatePreviewBtn = document.getElementById('update-preview-btn') as HTMLButtonElement;
const exportBtn = document.getElementById('export-btn') as HTMLButtonElement;
const undoBtn = document.getElementById('undo-btn') as HTMLButtonElement;
const redoBtn = document.getElementById('redo-btn') as HTMLButtonElement;
const imageGallery = document.getElementById('image-gallery') as HTMLDivElement;

// --- STATE & INITIALIZATION ---
let ai: GoogleGenAI;
let latestGeneratedImages: { id: string; url: string; prompt: string }[] = [];
let history: { html: string, css: string }[] = [];
let historyIndex = -1;

try {
    ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
} catch (error) {
    console.error(error);
    showError('Failed to initialize AI. Please check API Key configuration.');
}

const websiteGenerationSchema = {
    type: Type.OBJECT,
    properties: {
        pageTitle: {
            type: Type.STRING,
            description: "A concise, SEO-friendly title for the HTML page."
        },
        htmlContent: {
            type: Type.STRING,
            description: "The complete, well-structured, and well-indented HTML code for the website. This should include a <head> with a <style> tag for modern, responsive, and well-formatted CSS, and a <body>. Use semantic HTML5 tags. Image placeholders should have unique `id` attributes, e.g., `<img id='hero-image' alt='...'>`."
        },
        imagePrompts: {
            type: Type.ARRAY,
            description: "An array of objects, each describing an image to be generated for the website.",
            items: {
                type: Type.OBJECT,
                properties: {
                    id: {
                        type: Type.STRING,
                        description: "The unique ID of the <img> element in the HTML where this image should be placed."
                    },
                    prompt: {
                        type: Type.STRING,
                        description: "A simple, concise prompt (3-10 words) for an image that fits the website's theme. This will be enhanced by another AI later."
                    }
                },
                required: ["id", "prompt"]
            }
        }
    },
    required: ["pageTitle", "htmlContent", "imagePrompts"]
};

// --- EVENT LISTENERS ---
form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!ai) {
        showError('AI not initialized.');
        return;
    }
    const userPrompt = input.value.trim();
    if (!userPrompt) {
        input.focus();
        return;
    }

    // --- Construct detailed prompt from user options ---
    const pageType = pageTypeSelect.value;
    const imageCount = imageCountInput.value;
    const selectedSections = Array.from(sectionCheckboxes)
        .filter(cb => cb.checked)
        .map(cb => cb.value);

    let detailedPrompt = `Generate a website based on this core idea: "${userPrompt}".\n\n`;
    detailedPrompt += `**Website Structure Constraints:**\n`;
    detailedPrompt += `- **Page Type:** This should be structured as a "${pageType}".\n`;
    if (selectedSections.length > 0) {
        detailedPrompt += `- **Required Sections:** The website MUST include the following sections in a logical order: ${selectedSections.join(', ')}.\n`;
    }
    detailedPrompt += `- **Image Count:** Generate exactly ${imageCount} unique placeholder images for the site. Ensure the 'imagePrompts' array in your response contains ${imageCount} items.\n`;
    detailedPrompt += `\nRespond with ONLY the JSON object, adhering strictly to the provided schema.`;
    
    await generateWebsite(detailedPrompt);
});


tabs.addEventListener('click', (e) => {
    const target = e.target as HTMLButtonElement;
    if (!target.classList.contains('tab-button')) return;

    const tabName = target.dataset.tab;
    // FIX: Add a guard to ensure tabName is not null or undefined.
    if (!tabName) return;

    tabButtons.forEach(button => {
        button.classList.toggle('active', button === target);
        button.setAttribute('aria-selected', (button === target).toString());
    });

    tabContents.forEach(content => {
        const contentId = content.id;
        const isTargetContent = contentId.startsWith(tabName);
        content.classList.toggle('active', isTargetContent);
        content.hidden = !isTargetContent;
    });
});

updatePreviewBtn.addEventListener('click', () => {
    const htmlContent = htmlEditor.value;
    const cssContent = cssEditor.value;
    updatePreview(htmlContent, cssContent);
    pushHistoryState(htmlContent, cssContent);
});

exportBtn.addEventListener('click', async () => {
    if (!htmlEditor.value || latestGeneratedImages.length === 0) {
        alert("Please generate a website first before exporting.");
        return;
    }

    exportBtn.disabled = true;
    const exportBtnSpan = exportBtn.querySelector('span');
    if(exportBtnSpan) exportBtnSpan.textContent = 'Exporting...';

    try {
        const zip = new JSZip();
        const imagesFolder = zip.folder("images");

        const parser = new DOMParser();
        const doc = parser.parseFromString(htmlEditor.value, 'text/html');

        for (const image of latestGeneratedImages) {
            const imgElement = doc.getElementById(image.id) as HTMLImageElement;
            if (!imgElement) continue;
            
            const safeId = image.id.replace(/[^a-z0-9]/gi, '_').toLowerCase();
            const filename = `${safeId}.jpeg`;
            
            imgElement.src = `images/${filename}`;

            const response = await fetch(image.url);
            const blob = await response.blob();
            imagesFolder!.file(filename, blob);
        }

        doc.head.querySelectorAll('style').forEach(s => s.remove());
        const styleElement = doc.createElement('style');
        styleElement.textContent = cssEditor.value;
        doc.head.appendChild(styleElement);
        
        const finalHtml = doc.documentElement.outerHTML;
        zip.file("index.html", finalHtml);

        const content = await zip.generateAsync({ type: "blob" });
        const link = document.createElement("a");
        link.href = URL.createObjectURL(content);
        link.download = "ai-generated-website.zip";
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(link.href);

    } catch (error) {
        console.error("Error exporting website:", error);
        showError("An error occurred during the export process.");
    } finally {
        exportBtn.disabled = false;
        if(exportBtnSpan) exportBtnSpan.textContent = 'Export as .zip';
    }
});

undoBtn.addEventListener('click', () => {
    if (historyIndex > 0) {
        historyIndex--;
        loadStateFromHistory();
    }
});

redoBtn.addEventListener('click', () => {
    if (historyIndex < history.length - 1) {
        historyIndex++;
        loadStateFromHistory();
    }
});

// --- CORE FUNCTIONS ---
async function improveImagePrompts(prompts: {id: string, prompt: string}[]): Promise<{id: string, prompt: string}[]> {
    setLoadingState(true, `Enhancing ${prompts.length} image descriptions for photo-realism...`);

    const systemInstruction = `You are a world-class prompt engineer for generative AI image models. Your task is to take a simple image description and expand it into a detailed, descriptive prompt that will generate a stunning, photo-realistic image.

Focus on these elements:
- **Subject:** Clearly define the main subject and its actions or pose.
- **Setting/Background:** Describe the environment in detail.
- **Lighting:** Specify the type of lighting (e.g., golden hour, soft studio light, dramatic backlighting).
- **Composition:** Use photographic terms (e.g., wide-angle shot, close-up, rule of thirds).
- **Style/Mood:** Define the overall aesthetic (e.g., cinematic, ethereal, hyperrealistic, vintage photo).
- **Details:** Add specific, fine-grained details about textures, colors, and objects.

The final output MUST be only the improved prompt as a single, concise string, without any preamble, labels, or explanation.`;

    const improvedPromptsPromises = prompts.map(async (p) => {
        try {
            const response = await ai.models.generateContent({
                model: "gemini-2.5-flash",
                contents: `Original prompt: "${p.prompt}"`,
                config: {
                    systemInstruction: systemInstruction,
                    thinkingConfig: { thinkingBudget: 0 },
                    temperature: 0.5,
                }
            });
            return { id: p.id, prompt: response.text.trim() };
        } catch (error) {
            console.error(`Failed to improve prompt: "${p.prompt}"`, error);
            // Fallback to original prompt on error
            return p;
        }
    });

    return Promise.all(improvedPromptsPromises);
}


async function generateImages(prompts: {id: string, prompt: string}[]) {
    setLoadingState(true, `Generating ${prompts.length} images...`);
    const imageGenerationPromises = prompts.map(async (p) => {
        try {
            const response = await ai.models.generateImages({
                model: 'imagen-4.0-generate-001',
                prompt: p.prompt,
                config: {
                    numberOfImages: 1,
                    outputMimeType: 'image/jpeg',
                    aspectRatio: '16:9',
                },
            });
            const base64ImageBytes = response.generatedImages[0].image.imageBytes;
            const imageUrl = `data:image/jpeg;base64,${base64ImageBytes}`;
            return { id: p.id, url: imageUrl, prompt: p.prompt };
        } catch (error) {
            console.error(`Failed to generate image for prompt: "${p.prompt}"`, error);
            // Fallback to a placeholder on error
            return { id: p.id, url: `https://via.placeholder.com/1280x720.png?text=Image+Failed+To+Load`, prompt: p.prompt };
        }
    });
    return Promise.all(imageGenerationPromises);
}

async function generateWebsite(prompt: string) {
    setLoadingState(true, 'Analyzing your request...');
    generateBtn.disabled = true;
    inputSection.classList.add('hidden');
    resultContainer.classList.add('hidden');
    latestGeneratedImages = []; // Reset on new generation

    try {
        const systemInstruction = `You are a world-class AI web designer. Your task is to generate a complete, single-page website based on the user's detailed request.
- The entire website, including all text content, headings, and labels, MUST be in the same language as the user's prompt, unless a different language is explicitly requested.
- Ensure the generated HTML and the CSS within the <style> tag are well-formatted with proper indentation for readability.
- Use the year 2025 for any copyright notices or dates in the footer.
- Create modern, responsive, and aesthetically pleasing HTML and CSS.
- The CSS must be included within a <style> tag in the <head>.
- Use semantic HTML5 tags (e.g., <header>, <main>, <section>, <footer>).
- For images, create placeholders like \`<img id="unique-image-id-1" alt="descriptive alt text">\` where the image should go.
- The 'id' for each image placeholder must be unique.
- Generate a simple, concise prompt (3-10 words) for each image placeholder. This prompt will be enhanced by another AI later.
- Your entire response MUST be a single JSON object that strictly follows the provided schema. Do not include any markdown formatting (like \`\`\`json) or any other text outside of the JSON object.`;

        const response = await ai.models.generateContent({
            model: "gemini-2.5-flash",
            contents: prompt,
            config: {
                responseMimeType: "application/json",
                responseSchema: websiteGenerationSchema,
                temperature: 0.2,
            },
            systemInstruction: systemInstruction,
        });

        const websiteData = JSON.parse(response.text);

        // --- Image Generation Pipeline ---
        const improvedPrompts = await improveImagePrompts(websiteData.imagePrompts);
        const generatedImages = await generateImages(improvedPrompts);

        populateUI(websiteData.htmlContent, generatedImages);

    } catch (error) {
        console.error("Error during website generation:", error);
        showError("An error occurred while generating the website. Please try again.");
    } finally {
        setLoadingState(false);
        generateBtn.disabled = false;
    }
}


function populateUI(html: string, images: { id: string; url: string; prompt: string }[]) {
    latestGeneratedImages = images; // Store images for export
    // --- Separate HTML and CSS ---
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');
    const styleElement = doc.querySelector('style');
    const cssContent = styleElement?.textContent || '';
    styleElement?.remove(); // Remove from the parsed doc so it's not in the HTML editor
    const htmlContent = doc.documentElement.outerHTML;

    htmlEditor.value = htmlContent;
    cssEditor.value = cssContent;

    // --- Initialize History for Undo/Redo ---
    history = [];
    historyIndex = -1;
    pushHistoryState(htmlContent, cssContent);

    // --- Populate Images Tab ---
    imageGallery.innerHTML = ''; // Clear previous images
    images.forEach(image => {
        const galleryItem = document.createElement('div');
        galleryItem.className = 'gallery-item';
        galleryItem.innerHTML = `
            <img src="${image.url}" alt="Generated image for ${image.id}">
            <p><strong>ID:</strong> ${image.id}</p>
            <p><strong>Prompt:</strong> ${image.prompt}</p>
        `;
        imageGallery.appendChild(galleryItem);
    });

    // --- Update Preview ---
    // Inject the generated images into the parsed HTML document
    const previewDoc = parser.parseFromString(htmlContent, 'text/html');
    images.forEach(image => {
        const imgElement = previewDoc.getElementById(image.id) as HTMLImageElement;
        if (imgElement) {
            imgElement.src = image.url;
            imgElement.alt = image.prompt; // Use the detailed prompt for better accessibility
        }
    });

    // Re-inject the CSS for the preview
    const newStyleElement = previewDoc.createElement('style');
    newStyleElement.textContent = cssContent;
    previewDoc.head.appendChild(newStyleElement);


    previewFrame.srcdoc = previewDoc.documentElement.outerHTML;

    // --- Show Results ---
    resultContainer.classList.remove('hidden');
    // Ensure the preview tab is active by default
    // FIX: Cast Element to HTMLElement to access the click() method.
    (tabs.querySelector('[data-tab="preview"]') as HTMLElement)?.click();
}


function setLoadingState(isLoading: boolean, message: string = 'Analyzing your request...') {
    loadingContainer.classList.toggle('hidden', !isLoading);
    if (isLoading) {
        loadingText.textContent = message;
    }
}

function showError(message: string) {
    setLoadingState(false);
    inputSection.classList.remove('hidden');
    // For a better user experience, you might want to display this error in the UI
    alert(message);
}

function updatePreview(html: string, css: string) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');

    // Remove any pre-existing style tags from the head to avoid conflicts
    doc.head.querySelectorAll('style').forEach(s => s.remove());

    // Create and inject the new style tag with editor content
    const styleElement = doc.createElement('style');
    styleElement.textContent = css;
    doc.head.appendChild(styleElement);

    // Re-inject images into the preview from the latest generation
    latestGeneratedImages.forEach(image => {
        const imgElement = doc.getElementById(image.id) as HTMLImageElement;
        if (imgElement) {
            imgElement.src = image.url;
        }
    });

    previewFrame.srcdoc = doc.documentElement.outerHTML;
}

function pushHistoryState(html: string, css: string) {
    // If we are in the middle of the history, slice the future states
    if (historyIndex < history.length - 1) {
        history = history.slice(0, historyIndex + 1);
    }
    history.push({ html, css });
    historyIndex = history.length - 1;
    updateUndoRedoButtons();
}

function loadStateFromHistory() {
    const state = history[historyIndex];
    htmlEditor.value = state.html;
    cssEditor.value = state.css;
    updatePreview(state.html, state.css);
    updateUndoRedoButtons();
}

function updateUndoRedoButtons() {
    undoBtn.disabled = historyIndex <= 0;
    redoBtn.disabled = historyIndex >= history.length - 1;
}