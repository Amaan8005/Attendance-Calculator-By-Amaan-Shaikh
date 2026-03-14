document.addEventListener('DOMContentLoaded', async () => {
    const summaryView = document.getElementById('summaryView');
    const predictorView = document.getElementById('predictorView');
    const wrongPageView = document.getElementById('wrongPageView');
    const loadingView = document.getElementById('loadingView');

    const analyzeSummaryBtn = document.getElementById('analyzeSummaryBtn');
    const calculateFutureBtn = document.getElementById('calculateFutureBtn');

    const resultsDiv = document.getElementById('results');
    const predictorResultsDiv = document.getElementById('predictorResults');
    
    const startDateInput = document.getElementById('startDate');
    const endDateInput = document.getElementById('endDate');

    // --- 1. Local Storage for Dates ---
    chrome.storage.local.get(['savedStartDate', 'savedEndDate'], (result) => {
        if (result.savedStartDate) startDateInput.value = result.savedStartDate;
        if (result.savedEndDate) endDateInput.value = result.savedEndDate;
    });

    startDateInput.addEventListener('change', () => chrome.storage.local.set({ savedStartDate: startDateInput.value }));
    endDateInput.addEventListener('change', () => chrome.storage.local.set({ savedEndDate: endDateInput.value }));

    // --- 2. Main Logic: Detect page and show correct UI ---
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    
    try {
        // MAGIC FIX: allFrames: true tells Chrome to look inside embedded iFrames!
        const injectionResults = await chrome.scripting.executeScript({
            target: { tabId: tab.id, allFrames: true },
            files: ['content_script.js'],
        });

        loadingView.classList.add('hidden'); 

        if (!injectionResults || injectionResults.length === 0) {
            throw new Error("Script injection failed or returned no result.");
        }

        // Search through all frames to find the one that has the attendance data
        const validFrame = injectionResults.find(frame => frame.result && frame.result.type !== 'unknownPage');
        const pageInfo = validFrame ? validFrame.result : { type: 'unknownPage' };
        const targetFrameId = validFrame ? validFrame.frameId : 0; // Save the frame ID so we can talk to it later

        if (pageInfo.type === 'summaryPage') {
            summaryView.classList.remove('hidden');
            
            if (pageInfo.data && pageInfo.data.length > 0) {
                displaySummaryResults(pageInfo.data);
                analyzeSummaryBtn.onclick = () => {
                    analyzeSummaryBtn.textContent = 'Analyzed!';
                    analyzeSummaryBtn.style.backgroundColor = '#16a34a';
                };
            } else {
                 resultsDiv.innerHTML = `<div class="error-container">Could not find attendance data on this page.</div>`;
            }

        } else if (pageInfo.type === 'itineraryPage') {
            predictorView.classList.remove('hidden');
            
            if (!startDateInput.value || !endDateInput.value) {
                const today = new Date();
                const future = new Date();
                future.setDate(today.getDate() + 30);
                startDateInput.value = today.toISOString().split('T')[0];
                endDateInput.value = future.toISOString().split('T')[0];
            }

            calculateFutureBtn.addEventListener('click', async () => {
                predictorResultsDiv.innerHTML = `<div class="loading">Calculating...</div>`;
                const startDate = startDateInput.value;
                const endDate = endDateInput.value;
        
                if (!startDate || !endDate) {
                    predictorResultsDiv.innerHTML = `<div class="error-container">Please select a valid start and end date.</div>`;
                    return;
                }
                
                try {
                    // Send the message specifically to the iFrame that has the table
                    const itineraryResponse = await chrome.tabs.sendMessage(tab.id, { 
                        action: "calculateFromItinerary", 
                        startDate, 
                        endDate 
                    }, { frameId: targetFrameId });
        
                    if (itineraryResponse && itineraryResponse.results) {
                        displayPredictionResults(itineraryResponse.results);
                    } else {
                        predictorResultsDiv.innerHTML = `<div class="error-container">Could not find a schedule on this page.</div>`;
                    }
        
                } catch (e) {
                     predictorResultsDiv.innerHTML = `<div class="error-container">Could not run calculation. Is the page fully loaded? Please refresh and try again.</div>`;
                }
            });

        } else {
            wrongPageView.classList.remove('hidden');
        }

    } catch (error) {
        console.error("Initialization Error:", error);
        loadingView.classList.add('hidden');
        wrongPageView.classList.remove('hidden');
    }

    // --- 3. HELPER FUNCTIONS ---
    function buildTableHTML(dataObj, title) {
        if (Object.keys(dataObj).length === 0) return ''; 

        let tableHTML = `
            <h3>${title}</h3>
            <table>
                <thead>
                    <tr>
                        <th>Subject</th>
                        <th>Total</th>
                        <th>Attended</th>
                        <th>%</th>
                        <th>Can Skip</th>
                        <th>Needed</th>
                        <th>Simulate Skips</th>
                    </tr>
                </thead>
                <tbody>
        `;

        for (const subjectName in dataObj) {
            const pred = dataObj[subjectName];
            
            const total = parseInt(pred.total) || 0;
            const attended = parseInt(pred.attended) || 0;
            const currentPercentage = total > 0 ? (attended / total) : 0;

            if (pred.canSkip === undefined || pred.needed === undefined) {
                if (currentPercentage >= 0.75) {
                    pred.canSkip = attended - Math.ceil(0.75 * total);
                    pred.needed = 0;
                } else {
                    pred.canSkip = 0;
                    pred.needed = Math.ceil(3 * total - 4 * attended);
                }
            }

            const percentage = parseFloat(pred.percentage) || (currentPercentage * 100);
            
            const S = 1;
            const newTotal = total + S;
            const newPercentage = newTotal > 0 ? (attended / newTotal) : 0;
            
            let penaltyText = "";
            let penaltyClass = "";
            
            if (newPercentage >= 0.75) {
                const newCanSkip = attended - Math.ceil(0.75 * newTotal);
                penaltyText = `Safe ${newCanSkip}`; 
                penaltyClass = "percentage-good"; 
            } else {
                const newNeeded = Math.ceil(3 * newTotal - 4 * attended);
                penaltyText = `Need ${newNeeded}`; 
                penaltyClass = "percentage-bad"; 
            }

            const canSkipClass = pred.canSkip > 0 ? "percentage-good" : "percentage-bad";
            const neededClass = pred.needed > 0 ? "percentage-bad" : "percentage-good";
            
            tableHTML += `
                <tr>
                    <td title="${subjectName}">${subjectName}</td>
                    <td>${total}</td>
                    <td>${attended}</td>
                    <td class="${percentage >= 75 ? 'percentage-good' : 'percentage-bad'}">${percentage.toFixed(1)}%</td>
                    <td class="${canSkipClass}">${pred.canSkip}</td>
                    <td class="${neededClass}">${pred.needed}</td>
                    <td style="vertical-align: middle;">
                        <div style="display: flex; align-items: center; gap: 12px;">
                            <div class="sim-control">
                                <button class="sim-btn sim-minus" data-target="${subjectName}">-</button>
                                <input type="number" class="row-skip-input sim-input" id="input-${subjectName.replace(/\W/g, '')}" value="1" min="1" 
                                       data-total="${total}" data-attended="${attended}">
                                <button class="sim-btn sim-plus" data-target="${subjectName}">+</button>
                            </div>
                            <span class="skip-result ${penaltyClass}" style="min-width: 55px; display: inline-block;">${penaltyText}</span>
                        </div>
                    </td>
                </tr>
            `;
        }

        tableHTML += `</tbody></table>`;
        return tableHTML;
    }

    function displaySummaryResults(data) {
        resultsDiv.innerHTML = ''; 
        if (data.length === 0) {
            resultsDiv.innerHTML = `<div class="error-container">No summary data found.</div>`;
            return;
        }

        const theoryData = {};
        const practicalData = {};
        const otherData = {};

        data.forEach(sub => {
            const subjectName = sub.subjectName;
            const formattedData = {
                total: sub.total,
                attended: sub.attended,
                percentage: parseFloat(sub.attendance),
                canSkip: sub.canSkip,
                needed: sub.needed
            };

            if (subjectName.includes(':T')) {
                theoryData[subjectName] = formattedData;
            } else if (subjectName.includes(':P')) {
                practicalData[subjectName] = formattedData;
            } else {
                otherData[subjectName] = formattedData;
            }
        });

        resultsDiv.innerHTML = buildTableHTML(theoryData, 'Theory') + 
                               buildTableHTML(practicalData, 'Practical') + 
                               buildTableHTML(otherData, 'Other');
    }

    function displayPredictionResults(predictions) {
        predictorResultsDiv.innerHTML = ''; 
        if (Object.keys(predictions).length === 0) {
            predictorResultsDiv.innerHTML = `<div class="error-container">No lectures found in the selected date range.</div>`;
            return;
        }

        const theoryData = {};
        const practicalData = {};
        const otherData = {};

        for (const subjectName in predictions) {
            if (subjectName.includes(':T')) {
                theoryData[subjectName] = predictions[subjectName];
            } else if (subjectName.includes(':P')) {
                practicalData[subjectName] = predictions[subjectName];
            } else {
                otherData[subjectName] = predictions[subjectName];
            }
        }

        predictorResultsDiv.innerHTML = buildTableHTML(theoryData, 'Theory') + 
                                        buildTableHTML(practicalData, 'Practical') + 
                                        buildTableHTML(otherData, 'Other');
    }
});

// --- 4. INTERACTIVE SIMULATOR LOGIC ---
document.addEventListener('click', (e) => {
    if (e.target.classList.contains('sim-minus') || e.target.classList.contains('sim-plus')) {
        const container = e.target.closest('.sim-control');
        const inputBox = container.querySelector('.row-skip-input');
        let currentValue = parseInt(inputBox.value) || 1;

        if (e.target.classList.contains('sim-minus') && currentValue > 1) {
            inputBox.value = currentValue - 1;
        } else if (e.target.classList.contains('sim-plus')) {
            inputBox.value = currentValue + 1;
        }
        inputBox.dispatchEvent(new Event('input', { bubbles: true }));
    }
});

document.addEventListener('input', (e) => {
    if (e.target.classList.contains('row-skip-input')) {
        let S = parseInt(e.target.value);
        if (S < 1) {
            e.target.value = 1;
            S = 1;
        } else if (isNaN(S)) {
            S = 1;
        }
        
        const total = parseInt(e.target.getAttribute('data-total'));
        const attended = parseInt(e.target.getAttribute('data-attended'));
        
        const newTotal = total + S;
        const newPercentage = newTotal > 0 ? (attended / newTotal) : 0;
        
        let penaltyText = "";
        let penaltyClass = "";
        
        if (newPercentage >= 0.75) {
            const newCanSkip = attended - Math.ceil(0.75 * newTotal);
            penaltyText = `Safe ${newCanSkip}`;
            penaltyClass = "percentage-good";
        } else {
            const newNeeded = Math.ceil(3 * newTotal - 4 * attended);
            penaltyText = `Need ${newNeeded}`;
            penaltyClass = "percentage-bad";
        }
        
        const resultSpan = e.target.closest('.sim-control').nextElementSibling;
        resultSpan.textContent = penaltyText;
        resultSpan.className = `skip-result ${penaltyClass}`;
    }
});