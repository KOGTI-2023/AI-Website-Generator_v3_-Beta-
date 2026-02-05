/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
import { GoogleGenAI, Type } from "@google/genai";

// Let TS know that JSZip will be available on the window.
declare var JSZip: any;
declare var ace: any;

// --- DOM ELEMENT REFERENCES ---
const form = document.getElementById('prompt-form') as HTMLFormElement;
const input = document.getElementById('prompt-input') as HTMLTextAreaElement;
const generateBtn = document.getElementById('generate-btn') as HTMLButtonElement;
const loadingContainer = document.getElementById('loading-container') as HTMLDivElement;
const loadingText = document.getElementById('loading-text') as HTMLParagraphElement;
const progressBarFill = document.getElementById('progress-bar-fill') as HTMLDivElement;
const progressPercentage = document.getElementById('progress-percentage') as HTMLSpanElement;
const resultContainer = document.getElementById('result-container') as HTMLDivElement;
const inputSection = document.getElementById('input-section') as HTMLDivElement;

const pageTypeSelect = document.getElementById('page-type') as HTMLSelectElement;
const languageSelect = document.getElementById('language-select') as HTMLSelectElement;
const imageCountInput = document.getElementById('image-count') as HTMLInputElement;
const sectionCheckboxes = document.querySelectorAll<HTMLInputElement>('#section-checkboxes input[type="checkbox"]');
const exampleChips = document.querySelectorAll('.example-chip');

const tabs = document.querySelector('.tabs') as HTMLDivElement;
const tabButtons = document.querySelectorAll('.tab-button');
const tabContents = document.querySelectorAll<HTMLElement>('.tab-content');

const previewFrame = document.getElementById('preview-frame') as HTMLIFrameElement;
// Editors are now divs, initialized via Ace
const htmlEditorContainer = document.getElementById('html-editor') as HTMLDivElement;
const cssEditorContainer = document.getElementById('css-editor') as HTMLDivElement;

const updatePreviewBtn = document.getElementById('update-preview-btn') as HTMLButtonElement;
const exportBtn = document.getElementById('export-btn') as HTMLButtonElement;
const undoBtn = document.getElementById('undo-btn') as HTMLButtonElement;
const redoBtn = document.getElementById('redo-btn') as HTMLButtonElement;
const imageGallery = document.getElementById('image-gallery') as HTMLDivElement;

// --- INITIALIZE ACE EDITORS ---
const htmlEditor = ace.edit(htmlEditorContainer);
htmlEditor.setTheme("ace/theme/tomorrow_night");
htmlEditor.session.setMode("ace/mode/html");
htmlEditor.setOptions({
    fontSize: "14px",
    showPrintMargin: false,
    useWorker: false,
    fontFamily: "monospace"
});

const cssEditor = ace.edit(cssEditorContainer);
cssEditor.setTheme("ace/theme/tomorrow_night");
cssEditor.session.setMode("ace/mode/css");
cssEditor.setOptions({
    fontSize: "14px",
    showPrintMargin: false,
    useWorker: false,
    fontFamily: "monospace"
});

// --- STATE & INITIALIZATION ---
let ai: GoogleGenAI;
let latestGeneratedImages: { id: string; url: string; prompt: string }[] = [];
let latestFavicon: { url: string; prompt: string } | null = null;
let history: { html: string, css: string }[] = [];
let historyIndex = -1;
let autoSaveTimeout: number | undefined;

try {
    ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
} catch (error) {
    console.error(error);
    showError('Failed to initialize AI. Please check API Key configuration.');
}

// Check for Local Storage content on load
window.addEventListener('load', () => {
    loadStateFromLocalStorage();
});

// Setup Auto-Save listeners
htmlEditor.session.on('change', () => triggerAutoSave());
cssEditor.session.on('change', () => triggerAutoSave());

// Example Chips Logic
exampleChips.forEach(chip => {
    chip.addEventListener('click', () => {
        const text = (chip as HTMLElement).dataset.text;
        if (text) {
            input.value = text;
            input.focus();
        }
    });
});

const websiteGenerationSchema = {
    type: Type.OBJECT,
    properties: {
        pageTitle: {
            type: Type.STRING,
            description: "A concise, SEO-friendly title for the HTML page."
        },
        metaDescription: {
            type: Type.STRING,
            description: "A concise summary of the page content for search engines (150-160 characters)."
        },
        metaKeywords: {
            type: Type.STRING,
            description: "Comma-separated list of 5-10 relevant keywords for SEO."
        },
        faviconPrompt: {
            type: Type.STRING,
            description: "A very simple, minimal description for a square app icon or logo for this website (e.g., 'Minimalist blue hexagon logo')."
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
    required: ["pageTitle", "metaDescription", "metaKeywords", "faviconPrompt", "htmlContent", "imagePrompts"]
};

// --- EVENT LISTENERS ---
form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!ai) {
        showError('AI not initialized. Please verify your API Key.');
        return;
    }
    
    // --- Input Validation ---
    const userPrompt = input.value.trim();
    if (!userPrompt) {
        showError('Bitte geben Sie eine Beschreibung für Ihre Website ein.');
        input.focus();
        return;
    }

    const MIN_PROMPT_LENGTH = 15;
    if (userPrompt.length < MIN_PROMPT_LENGTH) {
        showError(`Bitte geben Sie eine detailliertere Beschreibung ein (mindestens ${MIN_PROMPT_LENGTH} Zeichen).`);
        input.focus();
        return;
    }

    // --- Construct detailed prompt from user options ---
    const pageType = pageTypeSelect.value;
    const language = languageSelect.value;
    const imageCount = imageCountInput.value;
    const selectedSections = Array.from(sectionCheckboxes)
        .filter(cb => cb.checked)
        .map(cb => cb.value);

    let detailedPrompt = `Generate a website based on this core idea: "${userPrompt}".\n\n`;
    detailedPrompt += `**Website Structure Constraints:**\n`;
    detailedPrompt += `- **Language:** The text content of the website MUST be written in ${language}.\n`;
    detailedPrompt += `- **Page Type:** This should be structured as a "${pageType}".\n`;
    detailedPrompt += `- **Navigation:** The website MUST include a responsive navigation menu. On desktop, show links horizontally. On mobile, show a hamburger menu that toggles the links. The menu must include anchor links to the following sections: ${selectedSections.join(', ')}.\n`;
    if (selectedSections.length > 0) {
        detailedPrompt += `- **Required Sections:** The website MUST include the following sections in a logical order: ${selectedSections.join(', ')}.\n`;
    }
    detailedPrompt += `- **Image Count:** Generate exactly ${imageCount} unique placeholder images for the site. Ensure the 'imagePrompts' array in your response contains ${imageCount} items.\n`;
    detailedPrompt += `- **Date:** The current year is 2025. Ensure all dates and copyright notices use the year 2025.\n`;
    detailedPrompt += `\nRespond with ONLY the JSON object, adhering strictly to the provided schema.`;
    
    await generateWebsite(detailedPrompt, userPrompt, language);
});


tabs.addEventListener('click', (e) => {
    const target = e.target as HTMLButtonElement;
    if (!target.classList.contains('tab-button')) return;

    const tabName = target.dataset.tab;
    // FIX: Add a guard to ensure tabName is not null or undefined.
    if (!tabName) return;

    tabButtons.forEach(button => {
        button.setAttribute('data-selected', (button === target).toString());
        button.setAttribute('aria-selected', (button === target).toString());
        if (button === target) button.classList.add('active');
        else button.classList.remove('active');
    });

    tabContents.forEach(content => {
        const contentId = content.id;
        const isTargetContent = contentId.startsWith(tabName);
        content.classList.toggle('active', isTargetContent);
        content.hidden = !isTargetContent;
    });
    
    // Resize Ace editors when they become visible to prevent rendering issues
    if (tabName === 'html' || tabName === 'css') {
        htmlEditor.resize();
        cssEditor.resize();
    }
});

updatePreviewBtn.addEventListener('click', () => {
    const htmlContent = htmlEditor.getValue();
    const cssContent = cssEditor.getValue();
    updatePreview(htmlContent, cssContent);
    pushHistoryState(htmlContent, cssContent);
});

exportBtn.addEventListener('click', async () => {
    const htmlValue = htmlEditor.getValue();
    if (!htmlValue || latestGeneratedImages.length === 0) {
        alert("Bitte generieren Sie zuerst eine Website.");
        return;
    }

    exportBtn.disabled = true;
    const exportBtnSpan = exportBtn.querySelector('span');
    if(exportBtnSpan) exportBtnSpan.textContent = 'Erstelle ZIP...';

    try {
        const zip = new JSZip();
        const imagesFolder = zip.folder("images");

        const parser = new DOMParser();
        const doc = parser.parseFromString(htmlValue, 'text/html');

        // Handle Content Images
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

        // Handle Favicon
        if (latestFavicon) {
            const faviconLink = doc.querySelector("link[rel*='icon']") as HTMLLinkElement;
            if (faviconLink) {
                const faviconFilename = "favicon.jpeg";
                faviconLink.href = `images/${faviconFilename}`;
                
                const response = await fetch(latestFavicon.url);
                const blob = await response.blob();
                imagesFolder!.file(faviconFilename, blob);
            }
        }

        doc.head.querySelectorAll('style').forEach(s => s.remove());
        const styleElement = doc.createElement('style');
        styleElement.textContent = cssEditor.getValue();
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
        showError("Fehler beim Exportieren.");
    } finally {
        exportBtn.disabled = false;
        if(exportBtnSpan) exportBtnSpan.textContent = 'Download .zip';
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

// --- HELPER FUNCTIONS ---

function updateProgress(percentage: number, message: string) {
    progressBarFill.style.width = `${percentage}%`;
    progressPercentage.textContent = `${Math.round(percentage)}%`;
    loadingText.textContent = message;
}

function getFriendlyErrorMessage(error: any): string {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const lowerMsg = errorMessage.toLowerCase();

    if (errorMessage.includes('401') || errorMessage.includes('403') || lowerMsg.includes('api key')) {
         return "Authentifizierung fehlgeschlagen. Bitte überprüfen Sie Ihren API-Schlüssel.";
    }
    
    if (errorMessage.includes('429') || lowerMsg.includes('quota') || lowerMsg.includes('resource exhausted')) {
        return "API-Limit erreicht. Bitte versuchen Sie es später erneut.";
    }

    if (errorMessage.includes('503') || lowerMsg.includes('overloaded') || lowerMsg.includes('unavailable')) {
        return "Der AI-Dienst ist derzeit überlastet. Bitte warten Sie einen Moment.";
    }

    if (lowerMsg.includes('safety') || lowerMsg.includes('blocked') || lowerMsg.includes('harmful')) {
        return "Die Anfrage wurde blockiert. Bitte formulieren Sie Ihren Prompt sicherer.";
    }
    
    if (lowerMsg.includes('json') || lowerMsg.includes('syntax')) {
        return "Ungültiges Antwortformat der KI. Bitte versuchen Sie es erneut.";
    }
    
    if (errorMessage.includes('Failed to fetch')) {
        return "Netzwerkfehler. Bitte überprüfen Sie Ihre Internetverbindung.";
    }

    return `Ein unerwarteter Fehler ist aufgetreten: ${errorMessage.substring(0, 150)}...`;
}

// --- CORE FUNCTIONS ---
async function improveImagePrompts(prompts: {id: string, prompt: string}[], coreIdea: string): Promise<{id: string, prompt: string}[]> {
    updateProgress(50, `Optimiere ${prompts.length} Bildbeschreibungen...`);

    const systemInstruction = `You are an expert art director and prompt engineer. Your goal is to refine simple image descriptions into highly detailed, photorealistic prompts suitable for high-quality image generation models.

Context:
The user is building a website with the following core idea: "${coreIdea}".
All image prompts must be stylistically consistent with this theme.

Guidelines:
- **Details:** Add specific details about lighting (e.g., natural, studio, cinematic), composition (e.g., rule of thirds, depth of field), and texture.
- **Style:** Ensure a consistent, professional, and photorealistic style unless the context suggests otherwise (e.g., a cartoon site).
- **Clarity:** Keep the prompt focused on the visual elements. Avoid abstract concepts that are hard to visualize.
- **Output:** Return ONLY the refined prompt text. Do not add labels like "Refined Prompt:".

Example:
Input: "A photo of a coffee shop."
Refined: "A cozy, sunlit interior of a modern coffee shop with rustic wooden tables, a barista pouring latte art in the background, warm golden hour lighting, 4k resolution, highly detailed."`;

    // Process prompts in parallel but don't hold up progress UI too much
    const improvedPromptsPromises = prompts.map(async (p, index) => {
        try {
            const response = await ai.models.generateContent({
                model: "gemini-2.5-flash",
                contents: `Original prompt: "${p.prompt}"\n\nRefine this prompt to be photorealistic and relevant to the website context provided in the system instructions.`,
                config: {
                    systemInstruction: systemInstruction,
                    thinkingConfig: { thinkingBudget: 0 },
                    temperature: 0.7, 
                }
            });
            return { id: p.id, prompt: response.text.trim() };
        } catch (error) {
            console.warn(`Failed to improve prompt for ID ${p.id}: "${p.prompt}"`, error);
            return p;
        }
    });

    return Promise.all(improvedPromptsPromises);
}

async function generateFavicon(prompt: string): Promise<{ url: string; prompt: string } | null> {
    updateProgress(65, "Erstelle Website-Icon...");
    try {
        const response = await ai.models.generateImages({
            model: 'imagen-4.0-generate-001',
            prompt: `A modern, minimalist, vector-style logo icon. ${prompt}. High contrast, simple shapes, professional, white background.`,
            config: {
                numberOfImages: 1,
                outputMimeType: 'image/jpeg',
                aspectRatio: '1:1',
            },
        });
        const base64ImageBytes = response.generatedImages[0].image.imageBytes;
        const imageUrl = `data:image/jpeg;base64,${base64ImageBytes}`;
        return { url: imageUrl, prompt: prompt };
    } catch (error) {
        console.error("Failed to generate favicon:", error);
        return null;
    }
}

async function generateImages(prompts: {id: string, prompt: string}[]) {
    // We start at 70% and move towards 95%
    let progress = 70;
    const progressStep = 25 / (prompts.length || 1);
    
    updateProgress(progress, `Generiere ${prompts.length} Bilder...`);

    const results = [];
    for (const p of prompts) {
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
            results.push({ id: p.id, url: imageUrl, prompt: p.prompt });
        } catch (error) {
             console.error(`Failed to generate image for prompt: "${p.prompt}"`, error);
             results.push({ id: p.id, url: `https://via.placeholder.com/1280x720.png?text=Image+Generation+Failed`, prompt: p.prompt });
        }
        
        progress += progressStep;
        updateProgress(progress, "Generiere Bilder...");
    }
    return results;
}

async function generateWebsite(detailedPrompt: string, coreIdea: string, language: string) {
    setLoadingState(true, 'Analysiere deine Anfrage...');
    updateProgress(10, 'Analysiere Anfrage...');
    
    generateBtn.disabled = true;
    inputSection.classList.add('hidden');
    resultContainer.classList.add('hidden');
    latestGeneratedImages = []; // Reset on new generation
    latestFavicon = null;

    try {
        const systemInstruction = `You are a world-class AI web designer. Your task is to generate a complete, single-page website based on the user's detailed request.
- The entire website, including all text content, headings, and labels, MUST be in ${language}.
- Ensure the generated HTML and the CSS within the <style> tag are well-formatted with proper indentation for readability.
- **Responsive Navigation:** You MUST include a responsive navigation bar in the <header>.
  - On desktop: Display navigation links horizontally.
  - On mobile: Display a hamburger menu icon. When clicked, it should toggle the navigation links.
  - Links: Include navigation links that anchor to the specific sections of the page (e.g., href="#about").
  - JS: Include a simple <script> tag at the end of the <body> to handle the mobile menu interaction (toggling a class like 'active' on the menu).
- Use the year 2025 for any copyright notices or dates in the footer. Do not use 2023 or 2024.
- Create modern, responsive, and aesthetically pleasing HTML and CSS.
- The CSS must be included within a <style> tag in the <head>.
- Use semantic HTML5 tags (e.g., <header>, <main>, <section>, <footer>).
- For images, create placeholders like \`<img id="unique-image-id-1" alt="descriptive alt text">\` where the image should go.
- The 'id' for each image placeholder must be unique.
- Generate a simple, concise prompt (3-10 words) for each image placeholder. This prompt will be enhanced by another AI later.
- Your entire response MUST be a single JSON object that strictly follows the provided schema. Do not include any markdown formatting (like \`\`\`json) or any other text outside of the JSON object.`;

        updateProgress(20, 'Erstelle Struktur & Code...');

        const response = await ai.models.generateContent({
            model: "gemini-2.5-flash",
            contents: detailedPrompt,
            config: {
                responseMimeType: "application/json",
                responseSchema: websiteGenerationSchema,
                temperature: 0.2,
            },
            systemInstruction: systemInstruction,
        });

        const websiteData = JSON.parse(response.text);

        // --- Image & Favicon Generation ---
        updateProgress(45, 'Optimiere Assets...');
        
        // Pass coreIdea to improvement step so the AI knows the website context
        // improveImagePrompts handles 50-60%, generateFavicon handles 65%
        const improvedPrompts = await improveImagePrompts(websiteData.imagePrompts, coreIdea);
        const faviconData = await generateFavicon(websiteData.faviconPrompt);
        
        latestFavicon = faviconData;
        
        // generateImages handles 70-95%
        const generatedImages = await generateImages(improvedPrompts);

        updateProgress(100, 'Finalisiere Website...');
        
        // Short delay to let the bar hit 100% visually
        await new Promise(r => setTimeout(r, 500));

        populateUI(websiteData.htmlContent, generatedImages, websiteData.metaDescription, websiteData.metaKeywords);

    } catch (error) {
        console.error("Error during website generation:", error);
        showError(getFriendlyErrorMessage(error));
    } finally {
        setLoadingState(false);
        generateBtn.disabled = false;
    }
}


function populateUI(html: string, images: { id: string; url: string; prompt: string }[], metaDesc: string, metaKeywords: string) {
    latestGeneratedImages = images; // Store images for export
    // --- Separate HTML and CSS ---
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');
    
    // Inject SEO Meta Tags
    if (metaDesc) {
        let meta = doc.querySelector('meta[name="description"]');
        if (!meta) {
            meta = doc.createElement('meta');
            meta.setAttribute('name', 'description');
            doc.head.appendChild(meta);
        }
        meta.setAttribute('content', metaDesc);
    }
    
    if (metaKeywords) {
        let meta = doc.querySelector('meta[name="keywords"]');
        if (!meta) {
            meta = doc.createElement('meta');
            meta.setAttribute('name', 'keywords');
            doc.head.appendChild(meta);
        }
        meta.setAttribute('content', metaKeywords);
    }

    // Inject Favicon
    if (latestFavicon) {
        let link = doc.querySelector("link[rel*='icon']") as HTMLLinkElement;
        if (!link) {
            link = doc.createElement('link');
            link.rel = 'icon';
            link.type = 'image/jpeg';
            doc.head.appendChild(link);
        }
        link.href = latestFavicon.url;
    }

    const styleElement = doc.querySelector('style');
    const cssContent = styleElement?.textContent || '';
    styleElement?.remove(); // Remove from the parsed doc so it's not in the HTML editor
    const htmlContent = doc.documentElement.outerHTML;

    // Set values in Ace Editors
    htmlEditor.setValue(htmlContent, -1);
    cssEditor.setValue(cssContent, -1);

    // --- Initialize History for Undo/Redo ---
    history = [];
    historyIndex = -1;
    pushHistoryState(htmlContent, cssContent);

    // --- Populate Images Tab ---
    imageGallery.innerHTML = ''; // Clear previous images
    
    if (latestFavicon) {
        const faviconItem = document.createElement('div');
        faviconItem.className = 'gallery-item';
        faviconItem.innerHTML = `
            <div class="aspect-square w-full p-8 flex items-center justify-center bg-zinc-900">
                <img src="${latestFavicon.url}" alt="Generated Favicon" class="w-24 h-24 object-contain">
            </div>
            <div class="p-4 border-t border-white/5 bg-zinc-950/50">
                <p class="text-xs font-semibold text-primary uppercase tracking-wider mb-1">Favicon</p>
                <p class="text-xs text-zinc-400 line-clamp-2" title="${latestFavicon.prompt}">${latestFavicon.prompt}</p>
            </div>
        `;
        imageGallery.appendChild(faviconItem);
    }

    images.forEach(image => {
        const galleryItem = document.createElement('div');
        galleryItem.className = 'gallery-item';
        galleryItem.innerHTML = `
            <div class="aspect-video w-full overflow-hidden">
                <img src="${image.url}" alt="Generated image for ${image.id}" class="w-full h-full object-cover">
            </div>
            <div class="p-4 border-t border-white/5 bg-zinc-950/50">
                <p class="text-xs font-semibold text-zinc-300 mb-1">ID: <span class="text-zinc-500 font-mono">${image.id}</span></p>
                <p class="text-xs text-zinc-400 line-clamp-2" title="${image.prompt}">${image.prompt}</p>
            </div>
        `;
        imageGallery.appendChild(galleryItem);
    });

    // --- Update Preview ---
    updatePreview(htmlContent, cssContent);

    // --- Show Results ---
    resultContainer.classList.remove('hidden');
    // Ensure the preview tab is active by default
    // FIX: Cast Element to HTMLElement to access the click() method.
    (tabs.querySelector('[data-tab="preview"]') as HTMLElement)?.click();
    
    // Save state after generation
    triggerAutoSave();
}


function setLoadingState(isLoading: boolean, message: string = 'Analysiere deine Anfrage...') {
    loadingContainer.classList.toggle('hidden', !isLoading);
    if (isLoading) {
        loadingText.textContent = message;
        // Reset progress bar
        progressBarFill.style.width = '5%';
        progressPercentage.textContent = '5%';
    }
}

function showError(message: string) {
    setLoadingState(false);
    inputSection.classList.remove('hidden');
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

    // Re-inject favicon if needed
    if (latestFavicon) {
         let link = doc.querySelector("link[rel*='icon']") as HTMLLinkElement;
         if (link) {
             link.href = latestFavicon.url;
         }
    }

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
    htmlEditor.setValue(state.html, -1);
    cssEditor.setValue(state.css, -1);
    updatePreview(state.html, state.css);
    updateUndoRedoButtons();
}

function updateUndoRedoButtons() {
    undoBtn.disabled = historyIndex <= 0;
    redoBtn.disabled = historyIndex >= history.length - 1;
}

// --- LOCAL STORAGE FUNCTIONS ---

function triggerAutoSave() {
    if (autoSaveTimeout) {
        clearTimeout(autoSaveTimeout);
    }
    // Debounce save by 1 second
    autoSaveTimeout = window.setTimeout(() => {
        saveStateToLocalStorage();
    }, 1000);
}

function saveStateToLocalStorage() {
    const htmlVal = htmlEditor.getValue();
    const cssVal = cssEditor.getValue();
    
    // Don't save empty states that might overwrite good data on load if not careful,
    // but here we allow it if user cleared it. 
    // Mainly we want to avoid saving if generation hasn't happened yet and editors are empty.
    if (!htmlVal && latestGeneratedImages.length === 0) return;

    const data = {
        html: htmlVal,
        css: cssVal,
        images: latestGeneratedImages,
        favicon: latestFavicon,
        timestamp: Date.now()
    };

    try {
        localStorage.setItem('ai-website-gen-data', JSON.stringify(data));
        console.log('Website state auto-saved.');
    } catch (e) {
        console.warn("Quota exceeded, clearing images from storage to save code only.", e);
        // Fallback: Try saving without images if quota exceeded (images are large)
        data.images = [];
        data.favicon = null;
        try {
            localStorage.setItem('ai-website-gen-data', JSON.stringify(data));
        } catch (innerError) {
             console.error("Failed to save even without images.", innerError);
        }
    }
}

function loadStateFromLocalStorage() {
    const savedData = localStorage.getItem('ai-website-gen-data');
    if (savedData) {
        try {
            const data = JSON.parse(savedData);
            if (data.html) {
                console.log('Restoring state from local storage...');
                
                // Restore logic similar to populateUI but without history reset
                latestGeneratedImages = data.images || [];
                latestFavicon = data.favicon || null;
                
                htmlEditor.setValue(data.html, -1);
                cssEditor.setValue(data.css, -1);
                
                // Re-populate gallery
                imageGallery.innerHTML = '';
                
                 if (latestFavicon) {
                    const faviconItem = document.createElement('div');
                    faviconItem.className = 'gallery-item';
                    faviconItem.innerHTML = `
                         <div class="aspect-square w-full p-8 flex items-center justify-center bg-zinc-900">
                            <img src="${latestFavicon.url}" alt="Generated Favicon" class="w-24 h-24 object-contain">
                        </div>
                        <div class="p-4 border-t border-white/5 bg-zinc-950/50">
                            <p class="text-xs font-semibold text-primary uppercase tracking-wider mb-1">Favicon</p>
                            <p class="text-xs text-zinc-400 line-clamp-2" title="${latestFavicon.prompt}">${latestFavicon.prompt}</p>
                        </div>
                    `;
                    imageGallery.appendChild(faviconItem);
                }
                
                latestGeneratedImages.forEach(image => {
                    const galleryItem = document.createElement('div');
                    galleryItem.className = 'gallery-item';
                    galleryItem.innerHTML = `
                        <div class="aspect-video w-full overflow-hidden">
                            <img src="${image.url}" alt="Generated image for ${image.id}" class="w-full h-full object-cover">
                        </div>
                        <div class="p-4 border-t border-white/5 bg-zinc-950/50">
                            <p class="text-xs font-semibold text-zinc-300 mb-1">ID: <span class="text-zinc-500 font-mono">${image.id}</span></p>
                            <p class="text-xs text-zinc-400 line-clamp-2" title="${image.prompt}">${image.prompt}</p>
                        </div>
                    `;
                    imageGallery.appendChild(galleryItem);
                });

                updatePreview(data.html, data.css);
                
                // Show result container if we have data
                inputSection.classList.add('hidden');
                resultContainer.classList.remove('hidden');
                
                // Init history with restored state
                history = [];
                pushHistoryState(data.html, data.css);
            }
        } catch (e) {
            console.error("Error parsing local storage data", e);
        }
    }
}