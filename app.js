/**
 * Web UART - Modern Serial Debugging Assistant Logic
 * Powered by Web Serial API
 */

document.addEventListener('DOMContentLoaded', () => {
    // Check compatibility
    if (!('serial' in navigator)) {
        const overlay = document.getElementById('unsupported-browser-overlay');
        if (window.location.protocol === 'file:') {
            overlay.querySelector('h2').textContent = '安全限制：请使用本地服务器打开';
            overlay.querySelector('p').innerHTML = 'Chrome 出于安全策略考量，<strong>禁止在本地直接双击打开的 HTML 文件（file:// 协议）中调用串口 API</strong>。<br><br>请在当前工作区终端运行 <strong>npm run dev</strong> 或 <strong>npm start</strong>，并在浏览器中访问 <strong>http://localhost:3000</strong> 即可完美使用。';
        } else if (window.location.protocol === 'http:' && !window.isSecureContext) {
            overlay.querySelector('h2').textContent = '安全限制：非本地安全上下文';
            overlay.querySelector('p').innerHTML = `您当前正在通过外部 IP (如局域网或 Tailscale <code>${window.location.host}</code>) 访问。<br><br>Chrome 安全策略强制规定，<strong>只有 localhost 或 HTTPS 链接才被允许使用串口 API</strong>。<br><br><strong>🔧 快速解决方法：</strong><br>1. 在 Chrome 地址栏打开：<code style="background: rgba(255,255,255,0.08); padding: 2px 6px; border-radius: 4px; color: var(--primary);">chrome://flags/#unsafely-treat-insecure-origin-as-secure</code><br>2. 找到该配置项，将其状态设为 <strong>Enabled</strong>。<br>3. 在下方的文本框中填入当前地址：<code style="background: rgba(255,255,255,0.08); padding: 2px 6px; border-radius: 4px; color: var(--primary);">http://${window.location.host}</code><br>4. 点击右下角 <strong>Relaunch</strong> 重启浏览器，即可完美解锁串口调试功能！`;
        }
        overlay.classList.remove('hidden');
        return;
    }

    // --- State Variables ---
    let port = null;
    let reader = null;
    let keepReading = false;
    let rxMode = 'text'; // 'text' | 'hex'
    let txMode = 'text'; // 'text' | 'hex'
    let rxBytes = 0;
    let txBytes = 0;
    let autoSendIntervalId = null;
    let isPaused = false;
    let textDecoder = new TextDecoder('utf-8', { fatal: false });
    
    // Terminal lines limitation
    const MAX_TERMINAL_LINES = 1500;
    let lineCount = 0;

    // RX frame assembly variables
    let rxChunksBuffer = [];
    let rxFrameTimerId = null;

    // Terminal Mode State Variables
    let isTerminalMode = false;
    let xtermInstance = null;
    let fitAddon = null;
    
    // Write queue to prevent stream concurrency issues
    let writeQueue = [];
    let isWriting = false;

    // --- DOM Elements ---
    const btnSelectPort = document.getElementById('btn-select-port');
    const selectedPortInfo = document.getElementById('selected-port-info');
    const selectBaudrate = document.getElementById('baudrate');
    const customBaudrateInput = document.getElementById('custom-baudrate');
    const btnModeMonitor = document.getElementById('btn-mode-monitor');
    const btnModeTerminal = document.getElementById('btn-mode-terminal');
    const xtermContainer = document.getElementById('xterm-container');
    const sendPanel = document.querySelector('.send-panel');
    const macroPanel = document.querySelector('.macro-panel');
    const selectDatabits = document.getElementById('databits');
    const selectStopbits = document.getElementById('stopbits');
    const selectParity = document.getElementById('parity');
    const selectFlowcontrol = document.getElementById('flowcontrol');
    const btnTogglePort = document.getElementById('btn-toggle-port');
    
    const chkDtr = document.getElementById('chk-dtr');
    const chkRts = document.getElementById('chk-rts');
    const statusLed = document.getElementById('status-led');
    const statusText = document.getElementById('status-text');
    const metricRx = document.getElementById('metric-rx');
    const metricTx = document.getElementById('metric-tx');
    const btnResetMetrics = document.getElementById('btn-reset-metrics');

    const rxFlash = document.getElementById('rx-flash');
    const txFlash = document.getElementById('tx-flash');
    const btnRxHex = document.getElementById('btn-rx-hex');
    const btnRxText = document.getElementById('btn-rx-text');
    const btnTxHex = document.getElementById('btn-tx-hex');
    const btnTxText = document.getElementById('btn-tx-text');
    
    const chkTimestamp = document.getElementById('chk-timestamp');
    const chkCopyTimestamp = document.getElementById('chk-copy-timestamp');
    const chkAutoscroll = document.getElementById('chk-autoscroll');
    const chkPause = document.getElementById('chk-pause');
    const btnCopyLog = document.getElementById('btn-copy-log');
    const btnExportLog = document.getElementById('btn-export-log');
    const btnClearLog = document.getElementById('btn-clear-log');
    
    const terminalContainer = document.getElementById('terminal-container');
    const lineEndingSelect = document.getElementById('line-ending');
    const chkAutoSend = document.getElementById('chk-auto-send');
    const autoSendIntervalInput = document.getElementById('auto-send-interval');
    const txTextarea = document.getElementById('tx-textarea');
    const btnSend = document.getElementById('btn-send');
    const btnClearSend = document.getElementById('btn-clear-send');
    const hexWarning = document.getElementById('hex-warning');
    const macroGrid = document.querySelector('.macro-grid');
    const btnSavePresets = document.getElementById('btn-save-presets');

    // Load previous configuration settings from localStorage
    loadConfigSettings();

    // --- Dynamic Macro Initialization ---
    const TOTAL_MACROS = 8;
    const defaultMacros = [
        { label: 'AT', value: 'AT' },
        { label: 'Version', value: 'AT+GMR' },
        { label: 'Reset', value: 'AT+RST' },
        { label: 'Help', value: 'help' },
        { label: 'CMD1', value: '01 03 00 00 00 02 C4 0B' },
        { label: 'CMD2', value: '01 06 00 01 00 01 19 CA' },
        { label: 'F7', value: '' },
        { label: 'F8', value: '' }
    ];

    // Load macro presets from localStorage or defaults
    let macros = JSON.parse(localStorage.getItem('web_uart_macros'));
    if (!macros || macros.length !== TOTAL_MACROS) {
        macros = defaultMacros;
    }

    // Render presets to UI
    function renderMacros() {
        macroGrid.innerHTML = '';
        macros.forEach((macro, index) => {
            const slot = document.createElement('div');
            slot.className = 'macro-slot';
            slot.innerHTML = `
                <span class="macro-key" title="快捷键 F${index + 1}">M${index + 1}</span>
                <input type="text" class="macro-input" id="macro-val-${index}" placeholder="发送内容..." value="${escapeHtml(macro.value)}">
                <button class="btn-send-macro" id="btn-send-macro-${index}" disabled>发送</button>
            `;
            macroGrid.appendChild(slot);

            // Bind individual click event
            const btnSendMacro = slot.querySelector(`.btn-send-macro`);
            btnSendMacro.addEventListener('click', () => {
                const inputVal = slot.querySelector(`.macro-input`).value;
                if (inputVal) {
                    sendDirect(inputVal);
                }
            });
        });
        updateMacroButtonsState();
    }

    // HTML escape utility
    function escapeHtml(text) {
        if (!text) return '';
        return text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    // Save presets
    btnSavePresets.addEventListener('click', () => {
        macros = [];
        for (let i = 0; i < TOTAL_MACROS; i++) {
            const val = document.getElementById(`macro-val-${i}`).value;
            macros.push({ label: `M${i+1}`, value: val });
        }
        localStorage.setItem('web_uart_macros', JSON.stringify(macros));
        
        // Show success visual indicator on the button temporarily
        const originalText = btnSavePresets.innerHTML;
        btnSavePresets.innerHTML = `
            <svg class="icon-inline" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polyline points="20 6 9 17 4 12"/>
            </svg>
            已保存!
        `;
        btnSavePresets.style.borderColor = 'var(--success)';
        btnSavePresets.style.color = 'var(--success)';
        
        setTimeout(() => {
            btnSavePresets.innerHTML = originalText;
            btnSavePresets.style.borderColor = '';
            btnSavePresets.style.color = '';
        }, 1500);
    });

    // --- Save & Load Config Settings ---
    function saveConfigSettings() {
        const config = {
            baudrate: selectBaudrate.value,
            customBaudrate: customBaudrateInput.value,
            databits: selectDatabits.value,
            stopbits: selectStopbits.value,
            parity: selectParity.value,
            flowcontrol: selectFlowcontrol.value
        };
        localStorage.setItem('web_uart_config', JSON.stringify(config));
    }

    function loadConfigSettings() {
        try {
            const config = JSON.parse(localStorage.getItem('web_uart_config'));
            if (config) {
                if (config.baudrate) selectBaudrate.value = config.baudrate;
                if (config.customBaudrate) customBaudrateInput.value = config.customBaudrate;
                if (config.databits) selectDatabits.value = config.databits;
                if (config.stopbits) selectStopbits.value = config.stopbits;
                if (config.parity) selectParity.value = config.parity;
                if (config.flowcontrol) selectFlowcontrol.value = config.flowcontrol;

                // Toggle custom baudrate input display
                if (selectBaudrate.value === 'custom') {
                    customBaudrateInput.classList.remove('hidden');
                } else {
                    customBaudrateInput.classList.add('hidden');
                }
            }
        } catch (e) {
            console.error('Error loading config from localStorage:', e);
        }
    }

    // --- Hot Reopen on Config Change ---
    async function handleHotReopen() {
        saveConfigSettings(); // Auto-save config settings
        if (port && keepReading) {
            logToTerminal('info', '检测到串口配置参数被修改，正在为您自动热重启串口以应用新配置...');
            await closePort();
            await openPort();
        }
    }

    // --- Custom Baud Rate Control & Hot Reopen ---
    selectBaudrate.addEventListener('change', async () => {
        if (selectBaudrate.value === 'custom') {
            customBaudrateInput.classList.remove('hidden');
            customBaudrateInput.focus();
        } else {
            customBaudrateInput.classList.add('hidden');
            await handleHotReopen();
        }
    });

    customBaudrateInput.addEventListener('change', handleHotReopen); // Triggered on Enter or blur
    selectDatabits.addEventListener('change', handleHotReopen);
    selectStopbits.addEventListener('change', handleHotReopen);
    selectParity.addEventListener('change', handleHotReopen);
    selectFlowcontrol.addEventListener('change', handleHotReopen);

    // --- Helper to Update Selected Port UI Info ---
    function updateSelectedPortUI(port, isAuto = false) {
        try {
            const info = port.getInfo();
            const hasUsbInfo = info.usbVendorId && info.usbProductId;
            if (hasUsbInfo) {
                const vid = `0x${info.usbVendorId.toString(16).padStart(4, '0').toUpperCase()}`;
                const pid = `0x${info.usbProductId.toString(16).padStart(4, '0').toUpperCase()}`;
                selectedPortInfo.textContent = `USB 设备 (VID: ${vid}, PID: ${pid})`;
            } else {
                selectedPortInfo.textContent = isAuto ? '已自动重连串口设备' : '已选择串口设备';
            }
            selectedPortInfo.style.borderColor = 'var(--primary)';
            selectedPortInfo.style.color = 'var(--primary)';
            btnTogglePort.disabled = false;
        } catch (e) {
            console.error('Error updating port UI:', e);
            selectedPortInfo.textContent = '已连接串口设备';
        }
    }

    btnSelectPort.addEventListener('click', async () => {
        try {
            // 1. Directly request the port first WITHOUT closing the current connection!
            const newPort = await navigator.serial.requestPort();
            
            // 2. Compare if the selected port is the same active device. If so, do nothing!
            if (port && newPort === port && keepReading) {
                return;
            }

            // 3. If a different port is selected and we have an active connection, close it first cleanly
            if (port && keepReading) {
                logToTerminal('info', '检测到您选择了不同的设备，正在自动关闭当前的旧连接以切换至新设备...');
                await closePort();
            }

            // 4. Bind the new port
            port = newPort;
            updateSelectedPortUI(port, false);
            
            const info = port.getInfo();
            const vid = info.usbVendorId ? `0x${info.usbVendorId.toString(16).padStart(4, '0').toUpperCase()}` : '未知';
            const pid = info.usbProductId ? `0x${info.usbProductId.toString(16).padStart(4, '0').toUpperCase()}` : '未知';
            logToTerminal('info', `已选择新设备 - USB Vendor ID: ${vid}, Product ID: ${pid}`);
            
            // 5. Automatically open the port immediately
            await openPort();
        } catch (err) {
            console.error('选择设备出错:', err);
            if (err.name !== 'NotFoundError') {
                logToTerminal('error', `选择设备失败: ${err.message}`);
            }
        }
    });

    btnTogglePort.addEventListener('click', async () => {
        if (port) {
            if (keepReading) {
                await closePort();
            } else {
                await openPort();
            }
        }
    });

    // --- Open Port ---
    async function openPort() {
        if (!port) return;

        // Configure options
        let baudRate = selectBaudrate.value === 'custom' ? parseInt(customBaudrateInput.value) : parseInt(selectBaudrate.value);
        if (isNaN(baudRate) || baudRate <= 0) {
            logToTerminal('error', '打开失败: 请输入有效的波特率');
            return;
        }

        const dataBits = parseInt(selectDatabits.value);
        const stopBits = parseInt(selectStopbits.value);
        const parity = selectParity.value;
        const flowControl = selectFlowcontrol.value;

        try {
            logToTerminal('info', `正在打开串口... (波特率: ${baudRate}, 数据位: ${dataBits}, 停止位: ${stopBits}, 校验: ${parity}, 流控: ${flowControl})`);
            
            await port.open({
                baudRate,
                dataBits,
                stopBits,
                parity,
                flowControl
            });

            // Serial now open
            keepReading = true;
            
            // Enable signal switches
            chkDtr.disabled = false;
            chkRts.disabled = false;

            // Apply default DTR/RTS signal states (logical true by default, releasing any stuck reset states)
            await applySignalSettings();

            // Setup UI states
            statusLed.className = 'led led-green';
            statusText.textContent = '已连接';
            statusText.style.color = 'var(--success)';
            btnTogglePort.innerHTML = `
                <svg class="icon-inline" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
                </svg>
                关闭串口
            `;
            btnTogglePort.className = 'btn btn-danger btn-full';

            // Enable configurations controls
            disableConfigControls(true);
            txTextarea.disabled = false;
            btnSend.disabled = false;
            btnClearSend.disabled = false;
            updateMacroButtonsState();

            logToTerminal('info', '串口已成功开启，数据接收轮询已启动。');

            // Query and update selectedPortInfo UI text AFTER the port is fully opened, ensuring real hardware VID/PID is loaded
            updateSelectedPortUI(port, false);

            // Launch read loop async
            readLoop();

        } catch (err) {
            console.error('无法打开串口:', err);
            logToTerminal('error', `打开串口失败: ${err.message}`);
            
            // Revert status
            statusLed.className = 'led led-red';
            statusText.textContent = '连接失败';
            statusText.style.color = 'var(--danger)';
        }
    }

    // --- Close Port ---
    async function closePort() {
        keepReading = false;
        
        // Cancel reader
        if (reader) {
            try {
                await reader.cancel();
            } catch (err) {
                console.error('取消 Reader 失败:', err);
            }
        }

        // Flush any remaining RX buffer data immediately upon close
        if (rxFrameTimerId) {
            clearTimeout(rxFrameTimerId);
            rxFrameTimerId = null;
        }
        if (rxChunksBuffer.length > 0) {
            const totalLength = rxChunksBuffer.reduce((acc, val) => acc + val.length, 0);
            const combined = new Uint8Array(totalLength);
            let offset = 0;
            for (const chunk of rxChunksBuffer) {
                combined.set(chunk, offset);
                offset += chunk.length;
            }
            processReceivedData(combined);
            rxChunksBuffer = [];
        }

        // Disable DTR/RTS signals UI
        chkDtr.disabled = true;
        chkRts.disabled = true;

        // Reset auto send state
        if (chkAutoSend.checked) {
            chkAutoSend.checked = false;
            stopAutoSend();
        }

        // Wait for read loop to shut down cleanly and release lock
        // This is safe because JS is single-threaded; giving control back to event loop ensures promises execute.
        await new Promise(resolve => setTimeout(resolve, 150));

        try {
            if (port) {
                await port.close();
            }
            logToTerminal('info', '串口已关闭。');
        } catch (err) {
            console.error('关闭串口失败:', err);
            logToTerminal('error', `关闭串口时出错: ${err.message}`);
        }

        // Revert UI to idle state
        statusLed.className = 'led led-red';
        statusText.textContent = '已断开';
        statusText.style.color = 'var(--text-muted)';
        
        btnTogglePort.innerHTML = `
            <svg class="icon-inline" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M18.36 6.64a9 9 0 11-12.73 0M12 2v10"/>
            </svg>
            打开串口
        `;
        btnTogglePort.className = 'btn btn-success btn-full';
        btnSelectPort.disabled = false;
        
        disableConfigControls(false);
        txTextarea.disabled = true;
        btnSend.disabled = true;
        btnClearSend.disabled = true;
        updateMacroButtonsState();
    }

    // --- Read Loop ---
    async function readLoop() {
        textDecoder = new TextDecoder('utf-8', { fatal: false });
        
        while (port.readable && keepReading) {
            try {
                reader = port.readable.getReader();
                
                while (keepReading) {
                    const { value, done } = await reader.read();
                    if (done) {
                        break;
                    }
                    if (value && value.length > 0) {
                        // Data packet received!
                        rxBytes += value.length;
                        updateMetricsUI();
                        
                        // Active Flash RX indicator
                        flashIndicator(rxFlash);

                        // Direct stream bypass for Interactive Terminal Mode
                        if (isTerminalMode) {
                            if (xtermInstance) {
                                xtermInstance.write(value);
                            }
                            continue;
                        }

                        if (!isPaused) {
                            // Append chunk to buffer for frame timeout assembly
                            rxChunksBuffer.push(value);
                            
                            // Reset frame interval timer (35ms threshold is optimal for most baud rates)
                            if (rxFrameTimerId) clearTimeout(rxFrameTimerId);
                            
                            rxFrameTimerId = setTimeout(() => {
                                // Assemble chunks into a single unified packet frame
                                const totalLength = rxChunksBuffer.reduce((acc, val) => acc + val.length, 0);
                                const combined = new Uint8Array(totalLength);
                                let offset = 0;
                                for (const chunk of rxChunksBuffer) {
                                    combined.set(chunk, offset);
                                    offset += chunk.length;
                                }
                                
                                processReceivedData(combined);
                                
                                rxChunksBuffer = [];
                                rxFrameTimerId = null;
                            }, 35);
                        }
                    }
                }
            } catch (err) {
                console.error('读取流发生错误:', err);
                if (keepReading) {
                    logToTerminal('error', `数据流接收错误: ${err.message}`);
                }
                break;
            } finally {
                if (reader) {
                    reader.releaseLock();
                    reader = null;
                }
            }
        }

        // Clean up connection states if loop finishes unexpectedly (e.g. device unplugged)
        if (keepReading) {
            logToTerminal('error', '通信意外中断，设备可能已被移除。');
            await closePort();
        }
    }

    // --- Process Received Byte Buffer ---
    function processReceivedData(uint8Array) {
        if (rxMode === 'text') {
            // Use streaming decode to handle split multibyte unicode characters elegantly
            const decodedStr = textDecoder.decode(uint8Array, { stream: true });
            
            // Check if we need to split by lines or display as stream chunk
            if (chkTimestamp.checked) {
                // Split by line endings so that each parsed line gets its own neat timestamp
                const lines = decodedStr.split(/\r?\n/);
                // Drop the trailing empty element if it was formed by a trailing newline
                if (lines.length > 1 && lines[lines.length - 1] === '') {
                    lines.pop();
                }
                lines.forEach(lineStr => {
                    logToTerminal('rx', lineStr);
                });
            } else {
                appendRawText(decodedStr);
            }
        } else {
            // Hex mode
            const hexArray = Array.from(uint8Array).map(b => b.toString(16).padStart(2, '0').toUpperCase());
            const hexStr = hexArray.join(' ') + ' ';
            logToTerminal('rx', hexStr);
        }
    }

    let isRestoring = false;

    // --- Raw Text Append Helper (Non-timestamp Mode) ---
    let activeRawSpan = null;
    function appendRawText(str) {
        if (!activeRawSpan) {
            const line = document.createElement('div');
            line.className = 'log-line';
            
            const tag = document.createElement('span');
            tag.className = 'log-tag rx';
            tag.textContent = 'RX';
            
            const content = document.createElement('span');
            content.className = 'log-content rx';
            
            line.appendChild(tag);
            line.appendChild(content);
            terminalContainer.appendChild(line);
            
            activeRawSpan = content;
            lineCount++;
        }

        // Safe HTML insertion with keyword highlighting
        const tempDiv = document.createElement('div');
        tempDiv.innerHTML = highlightKeywords(str);
        while (tempDiv.firstChild) {
            activeRawSpan.appendChild(tempDiv.firstChild);
        }
        
        // Handle scrolling
        if (chkAutoscroll.checked) {
            terminalContainer.scrollTop = terminalContainer.scrollHeight;
        }

        // Cap lines
        enforceTerminalCapacity();

        // Save to Session Storage
        if (!isRestoring) {
            saveLogToSession('rx', getCurrentFormattedTime(), str, true);
        }
    }

    // Reset raw stream node when switching modes or sending data
    function resetActiveRawSpan() {
        activeRawSpan = null;
    }

    // --- HTML Escaping & Keyword Highlighting ---
    function highlightKeywords(text) {
        if (!text) return '';
        // Escape HTML entities to prevent XSS
        let escaped = text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
        
        // Hex numbers (e.g. 0x01, 0xFF, 0x12AB)
        const hexNumRegex = /\b(0x[0-9a-fA-F]+)\b/g;
        // Error keywords (red)
        const errRegex = /\b(ERROR|FAIL|FAILED|ERR|TIMEOUT|FATAL|EXCEPTION|CRITICAL|ERROR:)\b/gi;
        // Success keywords (green)
        const okRegex = /\b(OK|SUCCESS|SUCCESSFUL|CONNECTED|READY|TRUE|ON|ACTIVE)\b/gi;
        // Warning keywords (yellow)
        const warnRegex = /\b(WARN|WARNING|WAIT|PENDING|FALSE|OFF|RETRY)\b/gi;
        // Info/System keywords (blue)
        const infoRegex = /\b(INFO|STATUS|DEBUG|SYSTEM|DEBUGS|NOTICE|REBOOT|STARTING)\b/gi;

        escaped = escaped.replace(hexNumRegex, '<span class="hl-hex">$1</span>');
        escaped = escaped.replace(errRegex, '<span class="hl-danger">$1</span>');
        escaped = escaped.replace(okRegex, '<span class="hl-success">$1</span>');
        escaped = escaped.replace(warnRegex, '<span class="hl-warning">$1</span>');
        escaped = escaped.replace(infoRegex, '<span class="hl-primary">$1</span>');
        
        return escaped;
    }    // --- Log to Terminal Display ---
    function logToTerminal(type, contentText, customTime = null) {
        resetActiveRawSpan();

        const line = document.createElement('div');
        line.className = 'log-line';

        const timeStr = customTime || getCurrentFormattedTime();

        // 1. Optional Time
        if (chkTimestamp.checked) {
            const timeSpan = document.createElement('span');
            timeSpan.className = 'log-time';
            timeSpan.textContent = timeStr;
            line.appendChild(timeSpan);
        }

        // 2. Tag representation
        const tagSpan = document.createElement('span');
        tagSpan.className = `log-tag ${type}`;
        tagSpan.textContent = type === 'info' ? 'SYS' : type;
        line.appendChild(tagSpan);

        // 3. Content String representation
        const contentSpan = document.createElement('span');
        contentSpan.className = `log-content ${type}`;
        contentSpan.innerHTML = highlightKeywords(contentText);
        line.appendChild(contentSpan);

        terminalContainer.appendChild(line);
        lineCount++;

        // Auto Scroll
        if (chkAutoscroll.checked) {
            terminalContainer.scrollTop = terminalContainer.scrollHeight;
        }

        // Enforce maximum buffer capacity
        enforceTerminalCapacity();

        // Save to Session Storage
        if (!isRestoring) {
            saveLogToSession(type, timeStr, contentText, false);
        }
    }
    function getCurrentFormattedTime() {
        const d = new Date();
        const hrs = d.getHours().toString().padStart(2, '0');
        const mins = d.getMinutes().toString().padStart(2, '0');
        const secs = d.getSeconds().toString().padStart(2, '0');
        const ms = d.getMilliseconds().toString().padStart(3, '0');
        return `${hrs}:${mins}:${secs}.${ms}`;
    }

    function enforceTerminalCapacity() {
        if (lineCount > MAX_TERMINAL_LINES) {
            const lines = terminalContainer.querySelectorAll('.log-line');
            const toRemove = lineCount - MAX_TERMINAL_LINES;
            for (let i = 0; i < toRemove; i++) {
                if (lines[i]) {
                    lines[i].remove();
                }
            }
            lineCount = MAX_TERMINAL_LINES;
        }
    }

    // --- Session Storage Log Persistence ---
    function saveLogToSession(type, timeStr, contentText, isRaw) {
        try {
            let sessionLogs = JSON.parse(sessionStorage.getItem('web_uart_session_logs') || '[]');
            
            // Merge consecutive raw RX logs to optimize storage and speed up restoration
            if (isRaw && sessionLogs.length > 0 && sessionLogs[sessionLogs.length - 1].isRaw) {
                sessionLogs[sessionLogs.length - 1].content += contentText;
            } else {
                sessionLogs.push({ type, time: timeStr, content: contentText, isRaw });
            }

            // Cap logs buffer size to keep storage extremely lightweight
            if (sessionLogs.length > 1000) {
                sessionLogs = sessionLogs.slice(sessionLogs.length - 1000);
            }
            sessionStorage.setItem('web_uart_session_logs', JSON.stringify(sessionLogs));
        } catch (e) {
            console.error('Error saving log to sessionStorage:', e);
        }
    }

    function restoreSessionLogs() {
        try {
            const sessionLogs = JSON.parse(sessionStorage.getItem('web_uart_session_logs') || '[]');
            if (sessionLogs.length > 0) {
                isRestoring = true;

                sessionLogs.forEach(log => {
                    if (log.isRaw) {
                        appendRawText(log.content);
                    } else {
                        logToTerminal(log.type, log.content, log.time);
                    }
                });

                isRestoring = false;

                // Auto Scroll
                if (chkAutoscroll.checked) {
                    terminalContainer.scrollTop = terminalContainer.scrollHeight;
                }
            }
        } catch (e) {
            isRestoring = false;
            console.error('Error restoring logs from sessionStorage:', e);
        }
    }

    // --- Safe Queue-based Serial Writer ---
    async function sendRawBytes(byteArray) {
        if (!port || !port.writable) {
            return false;
        }
        
        writeQueue.push(byteArray);
        if (isWriting) return true;
        
        isWriting = true;
        while (writeQueue.length > 0) {
            const nextBytes = writeQueue.shift();
            try {
                const writer = port.writable.getWriter();
                await writer.write(nextBytes);
                writer.releaseLock();
                
                // UI feedback metrics update
                txBytes += nextBytes.length;
                updateMetricsUI();
                flashIndicator(txFlash);
            } catch (err) {
                console.error('Queue writing error:', err);
                isWriting = false;
                return false;
            }
        }
        isWriting = false;
        return true;
    }

    // --- TX Core Operations ---
    async function sendDirect(dataString) {
        if (!port || !port.writable) {
            logToTerminal('error', '发送失败: 串口未开启或不可写');
            return;
        }

        let byteArray = null;

        if (txMode === 'text') {
            // Apply line endings options
            let updatedData = dataString;
            const ending = lineEndingSelect.value;
            if (ending === 'lf') {
                updatedData += '\n';
            } else if (ending === 'cr') {
                updatedData += '\r';
            } else if (ending === 'crlf') {
                updatedData += '\r\n';
            }

            byteArray = new TextEncoder().encode(updatedData);
        } else {
            // Hex Mode Processing
            // Strip spaces & validate Hex values
            const cleanStr = dataString.replace(/\s+/g, '');
            if (!/^[0-9a-fA-F]*$/.test(cleanStr) || cleanStr.length % 2 !== 0) {
                hexWarning.classList.remove('hidden');
                setTimeout(() => hexWarning.classList.add('hidden'), 3500);
                return;
            }

            // Convert Hex characters sequence to byte buffer array
            byteArray = new Uint8Array(cleanStr.length / 2);
            for (let i = 0; i < cleanStr.length; i += 2) {
                byteArray[i / 2] = parseInt(cleanStr.substr(i, 2), 16);
            }
            
            // Apply Hex suffix line endings if selected
            const ending = lineEndingSelect.value;
            let suffixBytes = [];
            if (ending === 'lf') {
                suffixBytes = [0x0A]; // \n
            } else if (ending === 'cr') {
                suffixBytes = [0x0D]; // \r
            } else if (ending === 'crlf') {
                suffixBytes = [0x0D, 0x0A]; // \r\n
            }
            
            if (suffixBytes.length > 0) {
                const combined = new Uint8Array(byteArray.length + suffixBytes.length);
                combined.set(byteArray, 0);
                combined.set(suffixBytes, byteArray.length);
                byteArray = combined;
            }
        }

        if (!byteArray || byteArray.length === 0) return;

        // Use the safe write queue
        const success = await sendRawBytes(byteArray);
        if (success) {
            // Log Tx action to screen
            let displayString = dataString;
            if (txMode === 'hex') {
                // Show clean space-separated layout in output logs
                const cleanHex = dataString.replace(/\s+/g, '');
                const chunks = [];
                for (let i = 0; i < cleanHex.length; i += 2) {
                    chunks.push(cleanHex.substr(i, 2).toUpperCase());
                }
                displayString = chunks.join(' ');
            }
            logToTerminal('tx', displayString);
        } else {
            logToTerminal('error', '发送数据发生错误。');
        }
    }

    // Primary send button trigger
    btnSend.addEventListener('click', () => {
        const textVal = txTextarea.value;
        if (textVal) {
            sendDirect(textVal);
        }
    });

    // Clear send textarea trigger
    btnClearSend.addEventListener('click', () => {
        txTextarea.value = '';
    });

    // Support keyboard shortcuts Cmd+Enter / Ctrl+Enter to trigger sending
    txTextarea.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
            e.preventDefault();
            btnSend.click();
        }
    });

    // --- Hex Input Validation & Formatting Real-time ---
    txTextarea.addEventListener('input', () => {
        // Automatically hide the hex warning as soon as the user starts correcting or editing!
        hexWarning.classList.add('hidden');
        
        if (txMode === 'hex') {
            const originalVal = txTextarea.value;
            // Clean unneeded letters
            const filteredVal = originalVal.replace(/[^0-9a-fA-F\s]/g, '');
            if (originalVal !== filteredVal) {
                txTextarea.value = filteredVal;
            }
        }
    });

    // --- Automatic Loop Sender Control ---
    chkAutoSend.addEventListener('change', () => {
        if (chkAutoSend.checked) {
            startAutoSend();
        } else {
            stopAutoSend();
        }
    });

    function startAutoSend() {
        stopAutoSend(); // Ensure clean start

        let ms = parseInt(autoSendIntervalInput.value);
        if (isNaN(ms) || ms < 10) {
            ms = 1000;
            autoSendIntervalInput.value = 1000;
        }

        // Disable rate modifying inputs
        autoSendIntervalInput.disabled = true;

        autoSendIntervalId = setInterval(() => {
            const val = txTextarea.value;
            if (val && port && port.writable) {
                sendDirect(val);
            }
        }, ms);

        logToTerminal('info', `开启循环自动发送，周期: ${ms} 毫秒`);
    }

    function stopAutoSend() {
        if (autoSendIntervalId) {
            clearInterval(autoSendIntervalId);
            autoSendIntervalId = null;
            logToTerminal('info', '自动发送已停止。');
        }
        autoSendIntervalInput.disabled = false;
    }

    // --- Apply DTR & RTS Hardware Signals ---
    async function applySignalSettings() {
        if (!port || !port.setSignals) return;
        try {
            const dataTerminalReady = chkDtr.checked;
            const requestToSend = chkRts.checked;
            await port.setSignals({ dataTerminalReady, requestToSend });
        } catch (err) {
            console.warn('驱动程序不支持 DTR/RTS 信号设置:', err);
        }
    }

    chkDtr.addEventListener('change', applySignalSettings);
    chkRts.addEventListener('change', applySignalSettings);

    // --- Reset RX / TX metrics ---
    btnResetMetrics.addEventListener('click', () => {
        rxBytes = 0;
        txBytes = 0;
        updateMetricsUI();
        logToTerminal('info', '收发计数器已重置。');
    });

    function updateMetricsUI() {
        metricRx.textContent = `${rxBytes.toLocaleString()} Bytes`;
        metricTx.textContent = `${txBytes.toLocaleString()} Bytes`;
    }

    // --- Flash indicator tags utility ---
    function flashIndicator(elem) {
        elem.classList.add('active');
        // Retrieve and reset class after brief delay
        setTimeout(() => {
            elem.classList.remove('active');
        }, 120);
    }

    // --- Hex / Text mode switches ---
    btnRxHex.addEventListener('click', () => {
        rxMode = 'hex';
        btnRxHex.classList.add('active');
        btnRxText.classList.remove('active');
        resetActiveRawSpan();
    });
    btnRxText.addEventListener('click', () => {
        rxMode = 'text';
        btnRxText.classList.add('active');
        btnRxHex.classList.remove('active');
        resetActiveRawSpan();
    });

    btnTxHex.addEventListener('click', () => {
        txMode = 'hex';
        btnTxHex.classList.add('active');
        btnTxText.classList.remove('active');
        txTextarea.placeholder = "十六进制发送格式: 01 03 00 00 00 02 C4 0B";
        hexWarning.classList.add('hidden');
        
        // Clean current text area if it has non-hex values
        txTextarea.value = txTextarea.value.replace(/[^0-9a-fA-F\s]/g, '');
    });
    btnTxText.addEventListener('click', () => {
        txMode = 'text';
        btnTxText.classList.add('active');
        btnTxHex.classList.remove('active');
        txTextarea.placeholder = "输入要发送的数据...";
        hexWarning.classList.add('hidden');
    });

    // --- Log Controls ---
    chkPause.addEventListener('change', () => {
        isPaused = chkPause.checked;
        if (isPaused) {
            logToTerminal('info', '数据显示已暂停。后台接收依然持续进行。');
        } else {
            logToTerminal('info', '数据显示已恢复。');
        }
    });

    btnClearLog.addEventListener('click', () => {
        // Clear all log elements
        terminalContainer.innerHTML = '';
        lineCount = 0;
        resetActiveRawSpan();
        
        // Clear xterm screen if exists
        if (xtermInstance) {
            xtermInstance.clear();
        }
        
        // Clear cached logs in sessionStorage
        sessionStorage.removeItem('web_uart_session_logs');
    });

    // --- Helper to Reconstruct Highlighted Selection with or without Timestamps ---
    function getFormattedSelectionText(includeTimestamp) {
        const selection = window.getSelection();
        if (!selection || selection.rangeCount === 0) return '';
        
        const rawText = selection.toString();
        if (!rawText || rawText.trim().length === 0) return '';
        
        const range = selection.getRangeAt(0);
        const fragment = range.cloneContents();
        
        if (includeTimestamp) {
            // Reconstruct selected lines to insert their timestamps & tags
            const lines = terminalContainer.querySelectorAll('.log-line');
            let formattedText = '';
            
            lines.forEach(line => {
                if (range.intersectsNode(line)) {
                    const timeNode = line.querySelector('.log-time');
                    const tagNode = line.querySelector('.log-tag');
                    const contentNode = line.querySelector('.log-content');
                    
                    const time = timeNode ? `[${timeNode.textContent}] ` : '';
                    const tag = tagNode ? `[${tagNode.textContent}] ` : '';
                    const content = contentNode ? contentNode.textContent : '';
                    
                    formattedText += `${time}${tag}${content}\n`;
                }
            });
            
            return formattedText.trim() ? formattedText : rawText;
        } else {
            // Clean selection: remove all timestamps and tags from the DOM selection fragment
            const selectedLines = fragment.querySelectorAll('.log-line');
            if (selectedLines.length > 0) {
                let cleanLines = [];
                selectedLines.forEach(line => {
                    const contentNode = line.querySelector('.log-content');
                    if (contentNode) {
                        cleanLines.push(contentNode.textContent);
                    } else {
                        // Fallback if .log-content is not found
                        line.querySelectorAll('.log-time, .log-tag').forEach(node => node.remove());
                        cleanLines.push(line.textContent);
                    }
                });
                return cleanLines.join('\n');
            } else {
                // Single-line partial selection fallback
                fragment.querySelectorAll('.log-time, .log-tag').forEach(node => node.remove());
                return fragment.textContent;
            }
        }
    }

    // --- Smart copy text to Clipboard ---
    btnCopyLog.addEventListener('click', async () => {
        const includeTimestamp = chkCopyTimestamp.checked;
        const selectedText = getFormattedSelectionText(includeTimestamp);
        let textToCopy = '';

        if (selectedText) {
            textToCopy = selectedText;
        } else {
            // Copy the entire terminal log text
            const lines = terminalContainer.querySelectorAll('.log-line');
            if (lines.length === 0) {
                return; // Nothing to copy
            }

            lines.forEach(line => {
                const timeNode = line.querySelector('.log-time');
                const tagNode = line.querySelector('.log-tag');
                const contentNode = line.querySelector('.log-content');
                
                if (includeTimestamp) {
                    const time = timeNode ? `[${timeNode.textContent}] ` : '';
                    const tag = tagNode ? `[${tagNode.textContent}] ` : '';
                    const content = contentNode ? contentNode.textContent : '';
                    textToCopy += `${time}${tag}${content}\n`;
                } else {
                    const content = contentNode ? contentNode.textContent : '';
                    textToCopy += `${content}\n`;
                }
            });
        }

        if (!textToCopy) return;

        try {
            await navigator.clipboard.writeText(textToCopy);

            // Change icon to a success checkmark temporarily
            const originalIcon = btnCopyLog.innerHTML;
            btnCopyLog.innerHTML = `
                <svg viewBox="0 0 24 24" fill="none" stroke="var(--success)" stroke-width="2.5" style="width:16px; height:16px;">
                    <polyline points="20 6 9 17 4 12"/>
                </svg>
            `;
            btnCopyLog.style.borderColor = 'var(--success)';

            setTimeout(() => {
                btnCopyLog.innerHTML = originalIcon;
                btnCopyLog.style.borderColor = '';
            }, 1200);
        } catch (err) {
            console.error('复制失败:', err);
            alert('复制失败，请尝试手动使用 Ctrl+C 或 Cmd+C 复制选中的内容。');
        }
    });

    // --- Auto Copy on Selection (mouseup) ---
    terminalContainer.addEventListener('mouseup', () => {
        // Wait a tiny bit for the selection API to fully register the selection range
        setTimeout(async () => {
            const includeTimestamp = chkCopyTimestamp.checked;
            const textToCopy = getFormattedSelectionText(includeTimestamp);
            if (textToCopy && textToCopy.trim().length > 0) {
                try {
                    await navigator.clipboard.writeText(textToCopy);
                    showToast(includeTimestamp ? '已自动复制 (含时间戳)' : '已自动复制 (仅内容)');
                } catch (err) {
                    console.error('自动复制失败:', err);
                }
            }
        }, 30);
    });

    // --- Floating Toast Notification ---
    function showToast(message) {
        const oldToast = document.getElementById('terminal-toast');
        if (oldToast) oldToast.remove();

        const toast = document.createElement('div');
        toast.id = 'terminal-toast';
        toast.className = 'terminal-toast';
        toast.innerHTML = `
            <svg viewBox="0 0 24 24" fill="none" stroke="var(--success)" stroke-width="2.5" width="14" height="14" style="margin-right: 8px; flex-shrink: 0;">
                <polyline points="20 6 9 17 4 12"/>
            </svg>
            <span>${message}</span>
        `;
        
        const consolePanel = document.querySelector('.console-panel');
        if (consolePanel) {
            consolePanel.appendChild(toast);
            
            // Trigger visual transitions
            setTimeout(() => {
                toast.classList.add('visible');
            }, 30);

            // Automatic removal
            setTimeout(() => {
                toast.classList.remove('visible');
                setTimeout(() => {
                    toast.remove();
                }, 300);
            }, 1500);
        }
    }

    // --- Log export to Local Disk (.txt) ---
    btnExportLog.addEventListener('click', () => {
        const lines = terminalContainer.querySelectorAll('.log-line');
        if (lines.length === 0) {
            alert('当前没有可导出的日志。');
            return;
        }

        let fileText = '';
        lines.forEach(line => {
            const timeNode = line.querySelector('.log-time');
            const tagNode = line.querySelector('.log-tag');
            const contentNode = line.querySelector('.log-content');
            
            const time = timeNode ? `[${timeNode.textContent}] ` : '';
            const tag = tagNode ? `[${tagNode.textContent}] ` : '';
            const content = contentNode ? contentNode.textContent : '';
            
            fileText += `${time}${tag}${content}\n`;
        });

        // Blob setup and download triggers
        const blob = new Blob([fileText], { type: 'text/plain;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        
        // Formulate date string filenames
        const d = new Date();
        const dateStr = d.getFullYear() +
            ((d.getMonth()+1).toString().padStart(2, '0')) +
            (d.getDate().toString().padStart(2, '0')) + '_' +
            (d.getHours().toString().padStart(2, '0')) +
            (d.getMinutes().toString().padStart(2, '0')) +
            (d.getSeconds().toString().padStart(2, '0'));
        
        a.href = url;
        a.download = `serial_log_${dateStr}.txt`;
        document.body.appendChild(a);
        a.click();
        
        // Clean up
        setTimeout(() => {
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        }, 150);
    });

    // --- Helper states modifier ---
    function disableConfigControls(disabled) {
        // Keep config selectors always enabled to allow seamless hot-reopening!
    }

    function updateMacroButtonsState() {
        const allMacroButtons = document.querySelectorAll('.btn-send-macro');
        const serialConnected = port && keepReading;
        allMacroButtons.forEach(btn => {
            btn.disabled = !serialConnected;
        });
    }

    // --- xterm.js Initialization (Lazy Loading) ---
    function initXterm() {
        if (xtermInstance) return;

        // Verify Terminal is loaded from CDN
        if (typeof Terminal === 'undefined') {
            console.error('xterm.js is not loaded from CDN yet!');
            alert('终端渲染引擎正在加载中，请稍后或刷新重试。');
            return;
        }

        xtermInstance = new Terminal({
            cursorBlink: true,
            cursorStyle: 'block',
            fontFamily: '"JetBrains Mono", "Fira Code", Menlo, Monaco, Consolas, monospace',
            fontSize: 13,
            theme: {
                background: '#04060b',
                foreground: '#f0f4f8',
                cursor: '#38bdf8',
                selectionBackground: 'rgba(56, 189, 248, 0.3)',
                black: '#000000',
                red: '#f87171',
                green: '#4ade80',
                yellow: '#fbbf24',
                blue: '#60a5fa',
                magenta: '#c084fc',
                cyan: '#2dd4bf',
                white: '#e2e8f0'
            }
        });

        fitAddon = new FitAddon.FitAddon();
        xtermInstance.loadAddon(fitAddon);
        xtermInstance.open(xtermContainer);
        fitAddon.fit();

        // Welcome banner for terminal
        xtermInstance.writeln('\x1b[1;36m*** Web UART 交互式终端模式已激活 ***\x1b[0m');
        xtermInstance.writeln('\x1b[33m提示：如果连接的是 Linux Shell，请敲击 [回车] 键以激活终端输入。\x1b[0m\r\n');

        // Capture keyboard key inputs and pipe them through the serial write queue
        xtermInstance.onData(data => {
            if (!port || !port.writable) {
                return;
            }
            const encoder = new TextEncoder();
            const byteArray = encoder.encode(data);
            void sendRawBytes(byteArray);
        });

        // Auto Copy on Selection in Terminal Mode (mouseup)
        xtermContainer.addEventListener('mouseup', () => {
            setTimeout(async () => {
                if (!xtermInstance) return;
                const textToCopy = xtermInstance.getSelection();
                if (textToCopy && textToCopy.trim().length > 0) {
                    try {
                        await navigator.clipboard.writeText(textToCopy);
                        showToast('已自动复制 (终端)');
                    } catch (err) {
                        console.error('终端自动复制失败:', err);
                    }
                }
            }, 30);
        });

        // Right-Click to Paste in Terminal Mode (contextmenu - capture phase on window to guarantee bypass)
        window.addEventListener('contextmenu', async (event) => {
            if (event.target && event.target.closest && event.target.closest('#xterm-container')) {
                event.preventDefault(); // Prevent standard browser right-click menu
                event.stopPropagation(); // Stop event propagation
                if (!port || !port.writable) {
                    return;
                }
                try {
                    const text = await navigator.clipboard.readText();
                    if (text) {
                        const encoder = new TextEncoder();
                        const byteArray = encoder.encode(text);
                        void sendRawBytes(byteArray);
                    }
                    // Prevent terminal focus loss after pasting
                    if (xtermInstance) {
                        xtermInstance.focus();
                    }
                } catch (err) {
                    console.error('终端右键粘贴读取剪贴板失败:', err);
                    alert('粘贴失败，请确保已授予浏览器剪贴板读取权限！');
                }
            }
        }, true);
    }

    // --- Mode Switching UI Actions ---
    function switchMode(mode) {
        if (mode === 'terminal') {
            isTerminalMode = true;
            btnModeMonitor.classList.remove('active');
            btnModeTerminal.classList.add('active');
            
            terminalContainer.classList.add('hidden');
            xtermContainer.classList.remove('hidden');
            
            // Hide the send configuration & macro preset panels to let terminal expand to 100% height
            if (sendPanel) sendPanel.classList.add('hidden');
            if (macroPanel) macroPanel.classList.add('hidden');
            
            initXterm();
            
            // Adjust layouts after rendering completes
            setTimeout(() => {
                if (fitAddon) {
                    fitAddon.fit();
                    xtermInstance.focus();
                }
            }, 60);
        } else {
            isTerminalMode = false;
            btnModeTerminal.classList.remove('active');
            btnModeMonitor.classList.add('active');
            
            xtermContainer.classList.add('hidden');
            terminalContainer.classList.remove('hidden');
            
            // Show the send configuration & macro preset panels back
            if (sendPanel) sendPanel.classList.remove('hidden');
            if (macroPanel) macroPanel.classList.remove('hidden');
            
            // Scroll normal logger to bottom
            if (chkAutoscroll.checked) {
                terminalContainer.scrollTop = terminalContainer.scrollHeight;
            }
        }
    }

    btnModeMonitor.addEventListener('click', () => switchMode('monitor'));
    btnModeTerminal.addEventListener('click', () => switchMode('terminal'));

    // Handle Window Resizing for xterm.js
    window.addEventListener('resize', () => {
        if (isTerminalMode && fitAddon) {
            fitAddon.fit();
        }
    });

    // --- Initialise Presets Layout rendering ---
    renderMacros();

    // --- Restore cached serial logs from sessionStorage ---
    restoreSessionLogs();

    // --- Automatically focus the 'Select Device' button to allow instant keyboard trigger (Enter/Space) ---
    if (btnSelectPort) {
        btnSelectPort.focus();
    }
});
