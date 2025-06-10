const {
    Client,
    GatewayIntentBits,
    SlashCommandBuilder,
    REST,
    Routes,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder,
    PermissionsBitField
} = require('discord.js');
const cron = require('node-cron');
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));
const express = require('express');
const jwt = require('jsonwebtoken');
const fs = require('fs');
const path = require('path');

const rateLimitMap = new Map(); // Stores IP -> [timestamps]

const DEFENCE_RATE_LIMIT = {
    windowMs: 60 * 1000,  // 1 minute window
    maxRequests: 3        // Max 3 requests per IP per minute
};

function defenceRateLimiter(req, res, next) {
    const ip = req.ip || req.connection.remoteAddress;

    const now = Date.now();
    const timestamps = rateLimitMap.get(ip) || [];

    // Filter out old timestamps
    const recent = timestamps.filter(ts => now - ts < DEFENCE_RATE_LIMIT.windowMs);

    if (recent.length >= DEFENCE_RATE_LIMIT.maxRequests) {
        console.warn(`⚠️ Rate limit hit for IP ${ip}`);
        return res.status(429).json({
            message: '⏳ Too many requests. Please wait a minute before trying again.'
        });
    }

    recent.push(now);
    rateLimitMap.set(ip, recent);
    next();
}

// Bot token & client ID
const token = 'discordtoken';
const clientId = 'clientid';

const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent,GatewayIntentBits.GuildMembers]
});

const tribeMap = {
    1: 'Romans', 2: 'Teutons', 3: 'Gauls',
    4: 'Nature', 5: 'Natars', 6: 'Egyptians',
    7: 'Huns', 8: 'Spartans', 9: 'Vikings'
};

let latestVillageData = [];
const app = express(); // This line is missing

app.use(express.json());

// Track usage of index.html page
let webInterfaceUsage = {
    startDate: new Date(),
    totalVisits: 0,
    lastVisit: null,
    ipAddresses: new Set(),
    dailyVisits: {}, // Format: "YYYY-MM-DD": count
    formSubmissions: 0,
    standingDefences: 0,
    regularDefences: 0,
    languageStats: { en: 0, gr: 0 }
};

// Path for saving usage statistics
const usageDataPath = path.join(__dirname, 'usage-data.json');

// Function to load usage data from file
function loadUsageData() {
    try {
        if (fs.existsSync(usageDataPath)) {
            const data = JSON.parse(fs.readFileSync(usageDataPath, 'utf8'));
            
            // Convert IP addresses back to a Set
            const ipSet = new Set(data.ipAddresses || []);
            data.ipAddresses = ipSet;
            
            // Convert date strings back to Date objects if they exist
            if (data.lastVisit) {
                data.lastVisit = new Date(data.lastVisit);
            }
            
            if (data.startDate) {
                data.startDate = new Date(data.startDate);
            } else {
                data.startDate = new Date();
            }
            
            console.log(`✅ Loaded usage statistics from ${usageDataPath}`);
            return data;
        }
    } catch (err) {
        console.error(`❌ Error loading usage data: ${err.message}`);
    }
    
    // Initialize with current date if creating for the first time
    const defaultData = { ...webInterfaceUsage, startDate: new Date() };
    return defaultData;
}

// Function to save usage data to file
function saveUsageData() {
    try {
        // Create a copy of the data with the Set converted to an array
        const dataToSave = {
            ...webInterfaceUsage,
            ipAddresses: [...webInterfaceUsage.ipAddresses]
        };
        
        fs.writeFileSync(usageDataPath, JSON.stringify(dataToSave, null, 2), 'utf8');
        console.log(`✅ Saved usage statistics to ${usageDataPath}`);
    } catch (err) {
        console.error(`❌ Error saving usage data: ${err.message}`);
    }
}

// Load saved data on startup
webInterfaceUsage = loadUsageData();

// Schedule regular saving of usage data (every 15 minutes)
cron.schedule('*/15 * * * *', () => {
    saveUsageData();
    console.log('🕒 Auto-saved usage statistics');
});

app.get('/', (req, res) => {
    //index.html
    // Track usage statistics
    webInterfaceUsage.totalVisits++;
    webInterfaceUsage.lastVisit = new Date();
    
    const ip = req.ip || req.connection.remoteAddress;
    webInterfaceUsage.ipAddresses.add(ip);
    
    // Track daily usage
    const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD format
    webInterfaceUsage.dailyVisits[today] = (webInterfaceUsage.dailyVisits[today] || 0) + 1;
    
    // Save updated usage data
    saveUsageData();
    
    res.sendFile(__dirname + '/index.html');
});

// New endpoint for tracking detailed usage
app.post('/track-usage', express.json(), (req, res) => {
    const { event, language, data } = req.body;
    const ip = req.ip || req.connection.remoteAddress;
    
    if (event === 'pageview') {
        // Already tracked in the main route
    }
    else if (event === 'form_submit') {
        webInterfaceUsage.formSubmissions++;
        
        // Track language usage
        if (language && (language === 'en' || language === 'gr')) {
            webInterfaceUsage.languageStats[language]++;
        }
        
        // Track defence type
        if (data && typeof data.isStanding === 'boolean') {
            if (data.isStanding) {
                webInterfaceUsage.standingDefences++;
            } else {
                webInterfaceUsage.regularDefences++;
            }
        }
        
        // Save updated usage data
        saveUsageData();
    }
    
    res.status(200).send({ success: true });
});

// Fetch map.sql
async function fetchMapSQL() {
    console.log(`⏳ Waiting 10 seconds before downloading map.sql...`);
    await new Promise(resolve => setTimeout(resolve, 10000));

    console.log(`🌐 Downloading map.sql...`);
    try {
        const res = await fetch('https://united.x3.balkans.travian.com/map.sql');
        const data = await res.text();
        const lines = data.split('\n');

        latestVillageData = lines
            .filter(line => line.startsWith('INSERT'))
            .flatMap(line => {
                const matches = line.match(/\((.*?)\)/g);
                return matches.map(raw => {
                    const parts = raw
                        .slice(1, -1)
                        .split(/,(?=(?:[^']*'[^']*')*[^']*$)/)
                        .map(p => p.trim().replace(/^'|'$/g, ''));
                    return {
                        villageName: parts[5],
                        x: Number(parts[1]),
                        y: Number(parts[2]),
                        isCapital: parts[12] === 'TRUE',
                        playerName: parts[7],
                        tribe: Number(parts[3])
                    };
                });
            });

            global.latestVillageData = latestVillageData;


        console.log(`✅ Loaded ${latestVillageData.length} villages`);
    } catch (err) {
        console.error('❌ Failed to fetch map.sql:', err);
    }
}

fetchMapSQL();
cron.schedule('0 0 * * *', fetchMapSQL, { timezone: 'Etc/GMT' });

// Configuration management
const configPath = path.join(__dirname, 'server-config.json');
let serverConfig = {};

function loadConfig() {
    try {
        if (fs.existsSync(configPath)) {
            serverConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
            console.log('✅ Loaded server configuration');
        } else {
            serverConfig = { servers: {} };
            saveConfig();
        }
    } catch (err) {
        console.error('❌ Error loading server configuration:', err);
        serverConfig = { servers: {} };
    }
}

function saveConfig() {
    try {
        fs.writeFileSync(configPath, JSON.stringify(serverConfig, null, 2), 'utf8');
        console.log('✅ Saved server configuration');
    } catch (err) {
        console.error('❌ Error saving server configuration:', err);
    }
}

function getServerConfig(guildId) {
    return serverConfig.servers[guildId]?.defenceConfig || null;
}

// Load config on startup
loadConfig();

// Slash commands
const commands = [
    // /coords command with bilingual localization
    new SlashCommandBuilder()
        .setName('coords')
        .setNameLocalizations({ el: 'συντεταγμένες' })
        .setDescription('Get a Travian map link')
        .setDescriptionLocalizations({ el: 'Λάβετε έναν σύνδεσμο για τον χάρτη Travian' })
        .addIntegerOption(opt =>
            opt.setName('x')
               .setDescription('X coordinate')
               .setDescriptionLocalizations({ el: 'Συντεταγμένη Χ' })
               .setRequired(true)
        )
        .addIntegerOption(opt =>
            opt.setName('y')
               .setDescription('Y coordinate')
               .setDescriptionLocalizations({ el: 'Συντεταγμένη Υ' })
               .setRequired(true)
        ),

    // /villages command with bilingual localization
    new SlashCommandBuilder()
        .setName('villages')
        .setNameLocalizations({ el: 'χωριά' })
        .setDescription('View villages of a Travian player')
        .setDescriptionLocalizations({ el: 'Προβολή χωριών ενός παίκτη Travian' })
        .addStringOption(opt =>
            opt.setName('player')
               .setDescription('Player name')
               .setDescriptionLocalizations({ el: 'Όνομα παίκτη' })
               .setRequired(true)
        ),

    // /servers command with bilingual localization
    new SlashCommandBuilder()
        .setName('servers')
        .setNameLocalizations({ el: 'διακομιστές' })
        .setDescription('View all servers the bot is in (admin only)')
        .setDescriptionLocalizations({ el: 'Προβολή όλων των διακομιστών όπου βρίσκεται το bot (μόνο για διαχειριστές)' }),

    // /defence command with bilingual localization
    new SlashCommandBuilder()
        .setName('defence')
        .setNameLocalizations({ el: 'άμυνα' })
        .setDescription('Request a defence call.')
        .setDescriptionLocalizations({ el: 'Αίτηση κλήσης άμυνας' })
        .addIntegerOption(opt =>
            opt.setName('x')
               .setDescription('X coordinate')
               .setDescriptionLocalizations({ el: 'Συντεταγμένη Χ' })
               .setRequired(true)
        )
        .addIntegerOption(opt =>
            opt.setName('y')
               .setDescription('Y coordinate')
               .setDescriptionLocalizations({ el: 'Συντεταγμένη Υ' })
               .setRequired(true)
        )
        .addIntegerOption(opt =>
            opt.setName('amount')
               .setDescription('Amount of units needed')
               .setDescriptionLocalizations({ el: 'Ποσότητα μονάδων που απαιτούνται' })
               .setRequired(true)
        )
        .addStringOption(opt =>
            opt.setName('time')
               .setDescription('Attack time in BST (format: HH:mm)')
               .setDescriptionLocalizations({ el: 'Ώρα επίθεσης σε BST (μορφή: HH:mm)' })
               .setRequired(false)
        )
        .addBooleanOption(opt =>
            opt.setName('standing')
               .setDescription('If checked, the defence request will be standing and remain active for 24 hours')
               .setDescriptionLocalizations({ el: 'Αν επιλεγεί, το αίτημα άμυνας θα παραμείνει ενεργό για 24 ώρες' })
               .setRequired(false)
        )
        .addIntegerOption(opt =>
            opt.setName('crop')
               .setDescription('Amount of crop needed')
               .setDescriptionLocalizations({ el: 'Ποσότητα σιταριού που απαιτείται' })
               .setRequired(false)
        ),

    // New usage command
    new SlashCommandBuilder()
        .setName('usage')
        .setDescription('View web interface usage statistics (admin only)'),

    // Add config command to the commands array
    new SlashCommandBuilder()
        .setName('config')
        .setDescription('Configure defence call settings (admin only)')
        .addSubcommand(subcommand =>
            subcommand
                .setName('view')
                .setDescription('View current defence call configuration')
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName('set')
                .setDescription('Set defence call configuration')
                .addChannelOption(option =>
                    option
                        .setName('category')
                        .setDescription('Category for defence channels')
                        .setRequired(true)
                )
                .addRoleOption(option =>
                    option
                        .setName('view_role')
                        .setDescription('Role that can view defence channels')
                        .setRequired(true)
                )
                .addRoleOption(option =>
                    option
                        .setName('ping_role')
                        .setDescription('Role that gets pinged for defence calls')
                        .setRequired(true)
                )
                .addChannelOption(option =>
                    option
                        .setName('log_channel')
                        .setDescription('Channel for defence call logs')
                        .setRequired(true)
                )
                .addChannelOption(option =>
                    option
                        .setName('initiator_log')
                        .setDescription('Channel for defence call initiator logs')
                        .setRequired(true)
                )
        )
];

client.once('ready', async () => {
    console.log(`✅ Logged in as ${client.user.tag}`);
    const rest = new REST({ version: '10' }).setToken(token);
    try {
        console.log(`🔄 Registering commands...`);
        await rest.put(Routes.applicationCommands(clientId), { body: commands });
        console.log(`✅ Slash commands registered successfully.`);
    } catch (error) {
        console.error('❌ Failed to register commands:', error);
    }

    client.user.setPresence({
        status: 'online',
        activities: [{ name: 'Travian maps', type: 3 }]
    });

    // Restore defence channel collectors/timers
    for (const info of defenceChannels) {
        try {
            const guild = client.guilds.cache.get('1333494775374024735');
            if (!guild) continue;
            const channel = guild.channels.cache.get(info.channelId) || await guild.channels.fetch(info.channelId).catch(() => null);
            if (!channel) continue;
            
            // Only restore if not expired
            if (info.expiresAt && Date.now() > info.expiresAt) {
                try { await channel.delete(); } catch {}
                removeDefenceChannel(info.channelId);
                continue;
            }

            // Attach collector based on defence type
            const collector = channel.createMessageCollector();
            collector.on('collect', async message => {
                // Track the message
                addMessageToDefenceChannel(info.channelId, message);
                
                const match = message.content.match(/(\d+(?:\.\d+)?)(k|K|m|M)?\s*\/\s*(\d+(?:\.\d+)?)(k|K|m|M)?/);
                if (match) {
                    let number = parseFloat(match[1]);
                    const firstSuffix = match[2]?.toLowerCase();
                    if (firstSuffix === 'k') number *= 1000;
                    else if (firstSuffix === 'm') number *= 1000000;
                    if (match[3]) {
                        let targetNumber = parseFloat(match[3]);
                        const secondSuffix = match[4]?.toLowerCase();
                        if (secondSuffix === 'k') targetNumber *= 1000;
                        else if (secondSuffix === 'm') targetNumber *= 1000000;
                        if (Math.round(number) === Math.round(targetNumber) && Math.round(number) === info.amount) {
                            if (info.type === 'standing') {
                                const remainingTime = Math.ceil((info.expiresAt - Date.now()) / 3600000);
                                await channel.send(`✅ **Standing def completed, will be deleted in ${remainingTime} hours** / Ολοκληρώθηκε η σταθερή άμυνα, θα διαγραφεί σε ${remainingTime} ώρες.`);
                                
                                // Lock the channel for all roles
                                for (const roleId of DEFENCE_VIEW_ROLE) {
                                    await channel.permissionOverwrites.edit(roleId, {
                                        SendMessages: false
                                    });
                                }
                            } else {
                                await channel.send('✅ **Def call ended. Channel will be deleted in 2 hours** / Ολοκληρώθηκε η κλήση άμυνας. Το κανάλι θα διαγραφεί σε 2 ώρες.');
                                setTimeout(async () => {
                                    try { await channel.delete(); } catch {}
                                    removeDefenceChannel(info.channelId);
                                }, 2 * 60 * 60 * 1000);
                            }
                            collector.stop();
                        }
                    }
                }
            });

            // Schedule deletion if not already scheduled
            if (info.expiresAt) {
                const timeUntilExpiry = info.expiresAt - Date.now();
                if (timeUntilExpiry > 0) {
                    setTimeout(async () => {
                        try {
                            await channel.send('⏰ **Defence expired. Channel will now be deleted.**');
                            await channel.delete();
                        } catch {}
                        removeDefenceChannel(info.channelId);
                    }, timeUntilExpiry);
                } else {
                    // If already expired, delete immediately
                    try {
                        await channel.delete();
                    } catch {}
                    removeDefenceChannel(info.channelId);
                }
            }
        } catch (err) {
            console.error('Error restoring defence channel:', err);
        }
    }
});

const playerVillagePages = new Map();

// Constants
const ALLOWED_COMMAND_ROLES = getServerConfig('1333494775374024735')?.commandRoles?.allowedRoles || [];
const ADMIN_ROLE = getServerConfig('1333494775374024735')?.commandRoles?.adminRole;
const ADMIN_ID = getServerConfig('1333494775374024735')?.bot?.adminId;

// Store defence submissions: { [channelId]: [{ units, time, userId, username, submittedAt }] }
const defenceSubmissionsPath = path.join(__dirname, 'defence-submissions.json');
let defenceSubmissions = {};

function loadDefenceSubmissions() {
    try {
        if (fs.existsSync(defenceSubmissionsPath)) {
            const data = JSON.parse(fs.readFileSync(defenceSubmissionsPath, 'utf8'));
            return data.submissions || {};
        }
    } catch (err) {
        console.error('❌ Error loading defence submissions:', err);
    }
    return {};
}

function saveDefenceSubmissions() {
    try {
        console.log('Saving defence submissions:', JSON.stringify(defenceSubmissions, null, 2));
        fs.writeFileSync(defenceSubmissionsPath, JSON.stringify({ submissions: defenceSubmissions }, null, 2), 'utf8');
        console.log('Successfully saved defence submissions to:', defenceSubmissionsPath);
    } catch (err) {
        console.error('❌ Error saving defence submissions:', err);
    }
}

// Load defence submissions on startup
defenceSubmissions = loadDefenceSubmissions();

// Persistent defence channel tracking
const defenceChannelsPath = path.join(__dirname, 'defence-channels.json');
let defenceChannels = [];

function loadDefenceChannels() {
    try {
        if (fs.existsSync(defenceChannelsPath)) {
            const data = JSON.parse(fs.readFileSync(defenceChannelsPath, 'utf8'));
            return Array.isArray(data) ? data : [];
        }
    } catch (err) {
        console.error('❌ Error loading defence channels:', err);
    }
    return [];
}

function saveDefenceChannels() {
    try {
        fs.writeFileSync(defenceChannelsPath, JSON.stringify(defenceChannels, null, 2), 'utf8');
    } catch (err) {
        console.error('❌ Error saving defence channels:', err);
    }
}

function addDefenceChannel(info) {
    if (!defenceChannels.find(c => c.channelId === info.channelId)) {
        // Add initial message if provided
        if (info.initialMessage) {
            info.messages = [{
                content: info.initialMessage,
                timestamp: Date.now(),
                type: 'initial'
            }];
        } else {
            info.messages = [];
        }
        defenceChannels.push(info);
        saveDefenceChannels();
    }
}

function addMessageToDefenceChannel(channelId, message) {
    const channel = defenceChannels.find(c => c.channelId === channelId);
    if (channel) {
        if (!channel.messages) channel.messages = [];
        channel.messages.push({
            content: message.content,
            timestamp: Date.now(),
            type: 'response'
        });
        saveDefenceChannels();
    }
}

function removeDefenceChannel(channelId) {
    const idx = defenceChannels.findIndex(c => c.channelId === channelId);
    if (idx !== -1) {
        defenceChannels.splice(idx, 1);
        saveDefenceChannels();
    }
}

defenceChannels = loadDefenceChannels();

// Manually add channel 1381213841127378955 if not present (assume normal defence, 2h left)
if (!defenceChannels.find(c => c.channelId === 'ID')) {
    defenceChannels.push({
        channelId: 'ID',
        type: 'normal',
        amount: 0, // Set to 0 or update if you know the amount
        time: null, // Set to the correct time if known
        createdAt: Date.now(),
        expiresAt: Date.now() + 2 * 60 * 60 * 1000 // 2 hours from now
    });
    saveDefenceChannels();
}

// Existing interactionCreate events...
client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;

    if (interaction.commandName === 'coords') {
        const x = interaction.options.getInteger('x');
        const y = interaction.options.getInteger('y');
        return await interaction.reply({
            content: `🌍 Travian map link for (${x}, ${y}) / Σύνδεσμος χάρτη Travian για (${x}, ${y}): https://united.x3.balkans.travian.com/karte.php?x=${x}&y=${y}`,
            ephemeral: false
        });
    }

    if (interaction.commandName === 'villages') {
        const player = interaction.options.getString('player');
        const villages = latestVillageData
            .filter(v => v.playerName?.toLowerCase() === player.toLowerCase())
            .sort((a, b) => {
                if (a.isCapital && !b.isCapital) return -1;
                if (!a.isCapital && b.isCapital) return 1;
                return b.y - a.y;
            });

        if (villages.length === 0) {
            return await interaction.reply({ 
                content: `❌ No villages found for player **${player}** / Δεν βρέθηκαν χωριά για τον παίκτη **${player}**.`,
                ephemeral: true 
            });
        }

        const pages = [];
        for (let i = 0; i < villages.length; i += 25) {
            pages.push(villages.slice(i, i + 25));
        }

        playerVillagePages.set(interaction.user.id, {
            pages,
            player,
            tribe: tribeMap[villages[0].tribe] || 'Unknown'
        });

        await sendVillagePage(interaction, 0);
    }

    if (interaction.commandName === 'servers') {
        if (interaction.user.id !== ADMIN_ID) {
            return await interaction.reply({ content: '❌ You are not authorized. / Δεν έχετε δικαίωμα να χρησιμοποιήσετε αυτή την εντολή.', ephemeral: true });
        }

        const guilds = client.guilds.cache.map(g => `• ${g.name} (ID: ${g.id})`);
        const embed = new EmbedBuilder()
            .setTitle('🛡️ Servers the bot is in / Διακομιστές όπου βρίσκεται το bot')
            .setDescription(guilds.join('\n') || 'No servers found. / Δεν βρέθηκαν διακομιστές.')
            .setColor(0x2ecc71)
            .setFooter({ text: `Total: ${guilds.length} servers / Σύνολο: ${guilds.length} διακομιστές` });

        await interaction.reply({ embeds: [embed], ephemeral: true });
    }

    if (interaction.commandName === 'usage') {
        // Only allow administrators to use this command
        if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
            return await interaction.reply({ 
                content: '❌ This command is only available to administrators.',
                ephemeral: true 
            });
        }
        
        // Format the last visit time
        const lastVisitFormatted = webInterfaceUsage.lastVisit 
            ? `<t:${Math.floor(webInterfaceUsage.lastVisit.getTime() / 1000)}:R>` 
            : 'Never';
            
        // Format the start date
        const startDateFormatted = `<t:${Math.floor(webInterfaceUsage.startDate.getTime() / 1000)}:D>`;
        
        // Get daily visits for the last 7 days
        const today = new Date();
        const dailyStats = [];
        for (let i = 0; i < 7; i++) {
            const date = new Date(today);
            date.setDate(date.getDate() - i);
            const dateStr = date.toISOString().split('T')[0];
            const count = webInterfaceUsage.dailyVisits[dateStr] || 0;
            dailyStats.unshift(`**${dateStr}**: ${count}`);
        }
        
        // Calculate form submission rate (as percentage of total visits)
        const submissionRate = webInterfaceUsage.totalVisits > 0 
            ? Math.round((webInterfaceUsage.formSubmissions / webInterfaceUsage.totalVisits) * 100) 
            : 0;
            
        // Language preference as percentage
        const totalLanguageUses = webInterfaceUsage.languageStats.en + webInterfaceUsage.languageStats.gr;
        const enPercent = totalLanguageUses > 0 ? Math.round((webInterfaceUsage.languageStats.en / totalLanguageUses) * 100) : 0;
        const grPercent = totalLanguageUses > 0 ? Math.round((webInterfaceUsage.languageStats.gr / totalLanguageUses) * 100) : 0;
        
        // Create an embed with English-only text
        const embed = new EmbedBuilder()
            .setTitle('📊 Web Interface Usage Statistics')
            .setColor(0x3498db)
            .setDescription(`Tracking since: ${startDateFormatted}`)
            .addFields(
                { name: 'Total Visits', value: webInterfaceUsage.totalVisits.toString(), inline: true },
                { name: 'Unique IPs', value: webInterfaceUsage.ipAddresses.size.toString(), inline: true },
                { name: 'Last Visit', value: lastVisitFormatted, inline: true },
                { name: 'Form Submissions', value: `${webInterfaceUsage.formSubmissions} (${submissionRate}% of visits)`, inline: true },
                { name: 'Standing Defences', value: webInterfaceUsage.standingDefences.toString(), inline: true },
                { name: 'Regular Defences', value: webInterfaceUsage.regularDefences.toString(), inline: true },
                { name: 'Daily Stats (Last 7 Days)', value: dailyStats.join('\n') || 'No data' }
            )
            .setFooter({ text: 'Statistics are saved and persist through bot restarts' });
            
        await interaction.reply({ embeds: [embed], ephemeral: true });
    }

    if (interaction.commandName === 'defence') {
        const memberRoles = interaction.member.roles.cache.map(role => role.id);
        const hasPermission = ALLOWED_COMMAND_ROLES.some(role => memberRoles.includes(role));
        if (!hasPermission) {
            return interaction.reply({ 
                content: '❌ You are not authorized to use this command. / Δεν έχετε δικαίωμα να χρησιμοποιήσετε αυτή την εντολή.',
                ephemeral: true 
            });
        }

        const x = interaction.options.getInteger('x');
        const y = interaction.options.getInteger('y');
        const amount = interaction.options.getInteger('amount');
        const timeStr = interaction.options.getString('time');
        const isStanding = interaction.options.getBoolean('standing') || false;
        const cropAmount = interaction.options.getInteger('crop');

        

        // Validate time for non-standing defense
        if (!isStanding && !timeStr) {
            return interaction.reply({ 
                content: '❌ Time is required for normal defense calls / Απαιτείται ώρα για τις κανονικές κλήσεις άμυνας.',
                ephemeral: true 
            });
        }
        if (!isStanding && timeStr && !/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/.test(timeStr)) {
            return interaction.reply({ 
                content: '❌ Invalid time format. Please use HH:mm in BST / Μη έγκυρη μορφή ώρας. Παρακαλώ χρησιμοποιήστε HH:mm σε BST.',
                ephemeral: true 
            });
        }

        let attackTime = new Date();
        if (!isStanding && timeStr) {
            // Only process time conversion for non-standing defense
            const [bstHours, bstMinutes] = timeStr.split(':').map(Number);
            let utcHours = bstHours - 1;
            if (utcHours < 0) {
                utcHours += 24;
                attackTime.setUTCDate(attackTime.getUTCDate() - 1);
            }
            attackTime.setUTCHours(utcHours, bstMinutes, 0, 0);

            if (attackTime < new Date()) {
                attackTime.setUTCDate(attackTime.getUTCDate() + 1);
            }
        }

        const date = attackTime.toISOString().split('T')[0];
        // Find village owner at the coordinates      
        const village = latestVillageData.find(v => v.x === x && v.y === y);
        const villageIdentifier = village ? village.villageName.replace(/[^a-zA-Z0-9]/g, '') : `${x}_${y}`;
        const channelName = isStanding ? `standing-def-${villageIdentifier}-${date}` : `def-${villageIdentifier}-${date}`;
        
        try {
            const defenceConfig = getServerConfig(interaction.guild.id);
            if (!defenceConfig) {
                return await interaction.reply({
                    content: '❌ Defence call configuration not found. Please ask an administrator to set it up using `/config set`.',
                    ephemeral: true
                });
            }

            const defenceChannel = await interaction.guild.channels.create({
                name: channelName,
                type: 0,
                parent: defenceConfig.parentCategory,
                permissionOverwrites: [
                    {
                        id: interaction.guild.id,
                        deny: [PermissionsBitField.Flags.ViewChannel],
                    },
                    ...defenceConfig.viewRoles.map(roleId => ({
                        id: roleId,
                        allow: [
                            PermissionsBitField.Flags.ViewChannel,
                            PermissionsBitField.Flags.SendMessages,
                            PermissionsBitField.Flags.ReadMessageHistory
                        ]
                    }))
                ]
            });
                          
            await defenceChannel.send({
                content: `${defenceConfig.pingRoles.map(role => `<@&${role}>`).join(' ')} Defence request: **${amount}** units at (**${x}**, **${y}**)${!isStanding ? `\n🕒 Attack time: **${timeStr} BST** / Ώρα επίθεσης: **${timeStr} BST**` : ''}
🌍 https://united.x3.balkans.travian.com/karte.php?x=${x}&y=${y}`,
                allowedMentions: { roles: defenceConfig.pingRoles }
            });

            // Schedule notifications using absolute UTC time
            const notifications = [
                { minutes: 60, message: "1h till attack" },
                { minutes: 30, message: "30 minutes till attack" },
                { minutes: 15, message: "15 minutes till attack" },
                { minutes: 5, message: "5 minutes till attack" }
            ];
            
            const currentTimeUTC = new Date();
            console.log(`Current time (UTC/GMT+0): ${currentTimeUTC.toUTCString()}`);
            console.log(`Attack time (UTC/GMT+0): ${attackTime.toUTCString()}`);
            
            notifications.forEach(({ minutes, message }) => {
                const notifyTimeUTC = new Date(attackTime.getTime() - minutes * 60000);
                const delay = notifyTimeUTC.getTime() - currentTimeUTC.getTime();
                console.log(`Scheduling notification "${message}" for: ${notifyTimeUTC.toUTCString()}`);
                console.log(`Delay from now: ${delay}ms (${Math.round(delay / 60000)} minutes)`);
                
                if (delay > 0) {
                    setTimeout(async () => {
                        try {
                            console.log(`EXECUTING NOTIFICATION: "${message}" at ${new Date().toUTCString()}`);
                            await defenceChannel.send({
                                content: `${defenceConfig.pingRoles.map(role => `<@&${role}>`).join(' ')} **${message}**`,
                                allowedMentions: { roles: defenceConfig.pingRoles }
                            });
                        } catch (err) {
                            console.error(`Failed to send notification "${message}": ${err}`);
                        }
                    }, delay);
                } else {
                    console.log(`Skipping notification "${message}" as it's in the past`);
                }
            });
            
            await interaction.reply({
                content: `✅ Defence channel created: ${defenceChannel} / Δημιουργήθηκε το κανάλι άμυνας: ${defenceChannel}`,
                ephemeral: true
            });

            // Log the defence request in the log channel (ID: 1376166737086517268)
            const logChannel = interaction.guild.channels.cache.get('1376166737086517268');
            if (logChannel) {
                const logMessage = isStanding ? 
                    `Deff call/standing deff command was done by <@${interaction.user.id}>`
                    : `Deff call/standing deff command was done by <@${interaction.user.id}>`;
                logChannel.send(logMessage);
            }

            if (!isStanding) {
                // Normal defence collector code remains the same
                const collector = defenceChannel.createMessageCollector();
                collector.on('collect', async message => {
                    const match = message.content.match(/(\d+(?:\.\d+)?)(k|K|m|M)?\s*\/\s*(\d+(?:\.\d+)?)(k|K|m|M)?/);
                    if (match) {
                        let number = parseFloat(match[1]);
                        const firstSuffix = match[2]?.toLowerCase();
                        if (firstSuffix === 'k') number *= 1000;
                        else if (firstSuffix === 'm') number *= 1000000;

                        // Check if it's a format like "1k/1k" or "1000/1000"
                        if (match[3]) {
                            let targetNumber = parseFloat(match[3]);
                            const secondSuffix = match[4]?.toLowerCase();
                            if (secondSuffix === 'k') targetNumber *= 1000;
                            else if (secondSuffix === 'm') targetNumber *= 1000000;

                            if (Math.round(number) === Math.round(targetNumber) && Math.round(number) === amount) {
                                // Record the submission for normal defence only
                                if (!defenceSubmissions[defenceChannel.id]) defenceSubmissions[defenceChannel.id] = [];
                                const submission = {
                                    units: Math.round(number),
                                    time: timeStr,
                                    userId: message.author.id,
                                    username: message.member?.displayName || message.author.username,
                                    submittedAt: new Date().toISOString(),
                                    coordinates: { x, y },
                                    channelId: defenceChannel.id
                                };
                                console.log('Adding new submission:', submission);
                                defenceSubmissions[defenceChannel.id].push(submission);
                                saveDefenceSubmissions();
                                
                                // Lock the channel for all roles
                                for (const roleId of DEFENCE_VIEW_ROLE) {
                                    await defenceChannel.permissionOverwrites.edit(roleId, {
                                        SendMessages: false
                                    });
                                }
                                
                                await defenceChannel.send('✅ **Def call ended. Channel will be deleted in 2 hours** / Ολοκληρώθηκε η κλήση άμυνας. Το κανάλι θα διαγραφεί σε 2 ώρες.');
                                setTimeout(async () => {
                                    try { await defenceChannel.delete(); } catch {}
                                    removeDefenceChannel(defenceChannel.id);
                                }, 7200000);
                                collector.stop();
                            }
                        }
                    }
                });
            } else {
                // Standing defence collector
                const collector = defenceChannel.createMessageCollector();
                const creationTime = Date.now();
                const deletionTime = creationTime + 86400000;

                collector.on('collect', async message => {
                    const match = message.content.match(/(\d+(?:\.\d+)?)(k|K|m|M)?\s*\/\s*(\d+(?:\.\d+)?)(k|K|m|M)?/);
                    if (match) {
                        let number = parseFloat(match[1]);
                        const firstSuffix = match[2]?.toLowerCase();
                        if (firstSuffix === 'k') number *= 1000;
                        else if (firstSuffix === 'm') number *= 1000000;

                        // Check if it's a format like "1k/1k" or "1000/1000"
                        if (match[3]) {
                            let targetNumber = parseFloat(match[3]);
                            const secondSuffix = match[4]?.toLowerCase();
                            if (secondSuffix === 'k') targetNumber *= 1000;
                            else if (secondSuffix === 'm') targetNumber *= 1000000;

                            if (Math.round(number) === Math.round(targetNumber) && Math.round(number) === amount) {
                                const remainingTime = Math.ceil((deletionTime - Date.now()) / 3600000);
                                await defenceChannel.send(`✅ **Standing def completed, will be deleted in ${remainingTime} hours** / Ολοκληρώθηκε η σταθερή άμυνα, θα διαγραφεί σε ${remainingTime} ώρες.`);
                                
                                // Lock the channel for all roles
                                for (const roleId of DEFENCE_VIEW_ROLE) {
                                    await defenceChannel.permissionOverwrites.edit(roleId, {
                                        SendMessages: false
                                    });
                                }
                                
                                collector.stop();
                            }
                        }
                    }
                });

                // Schedule deletion after 24 hours
                setTimeout(async () => {
                    try {
                        await defenceChannel.send('⏰ **Standing defence expired. Channel will now be deleted.** / Έληξε ο χρόνος για την σταθερή άμυνα. Το κανάλι θα διαγραφεί τώρα.');
                        await defenceChannel.delete();
                    } catch (err) {
                        console.error(`Failed to delete standing defence channel: ${err}`);
                    }
                    removeDefenceChannel(defenceChannel.id);
                }, 86400000);
            }

            // Create a message collector for this defence channel
            const collector = defenceChannel.createMessageCollector({
                filter: msg => !msg.author.bot,
                time: 2 * 60 * 60 * 1000 // 2 hours
            });

            collector.on('collect', async (message) => {
                try {
                    // Skip bot messages
                    if (message.author.bot) return;

                    // Match the format: number / number
                    const match = message.content.match(/(\d+(?:\.\d+)?)(k|K|m|M)?\s*\/\s*(\d+(?:\.\d+)?)(k|K|m|M)?/);
                    if (!match) return;

                    const [_, unitsStr, unitsSuffix, targetStr, targetSuffix] = match;
                    let units = parseFloat(unitsStr);
                    let target = parseFloat(targetStr);

                    // Convert k/m suffixes to actual numbers
                    if (unitsSuffix?.toLowerCase() === 'k') units *= 1000;
                    if (unitsSuffix?.toLowerCase() === 'm') units *= 1000000;
                    if (targetSuffix?.toLowerCase() === 'k') target *= 1000;
                    if (targetSuffix?.toLowerCase() === 'm') target *= 1000000;

                    // Check if the submission matches the requested amount
                    if (Math.abs(units - target) <= 1) {
                        // Record the submission
                        if (!defenceSubmissions[defenceChannel.id]) {
                            defenceSubmissions[defenceChannel.id] = [];
                        }

                        const submission = {
                            units,
                            time: timeStr,
                            userId: message.author.id,
                            username: message.author.username,
                            submittedAt: new Date().toISOString(),
                            coordinates: { x, y },
                            channelId: defenceChannel.id,
                            type: isStanding ? 'standing' : 'normal'
                        };

                        defenceSubmissions[defenceChannel.id].push(submission);
                        console.log(`Added submission for channel ${defenceChannel.id}:`, submission);
                        console.log('Current submissions for channel:', defenceSubmissions[defenceChannel.id]);

                        // Save submissions
                        await saveDefenceSubmissions();

                        // Send confirmation
                        await message.reply(`✅ Defence submission recorded: ${units.toLocaleString()} units`);

                        // End the collector and delete the channel
                        collector.stop('defence_completed');
                    }
                } catch (error) {
                    console.error('Error processing defence submission:', error);
                }
            });

            collector.on('end', async (collected, reason) => {
                try {
                    console.log(`Defence channel ${defenceChannel.id} collector ended. Reason: ${reason}`);
                    
                    // Send final message
                    await defenceChannel.send('Defence call ended. This channel will be deleted in 2 hours.');
                    
                    // Remove submissions for this channel from the JSON file
                    if (defenceSubmissions[defenceChannel.id]) {
                        console.log(`Removing submissions for channel ${defenceChannel.id} from JSON file`);
                        delete defenceSubmissions[defenceChannel.id];
                        await saveDefenceSubmissions();
                    }
                    
                    // Schedule channel deletion
                    setTimeout(async () => {
                        try {
                            await defenceChannel.delete('Defence call completed');
                            console.log(`Deleted defence channel ${defenceChannel.id}`);
                        } catch (error) {
                            console.error(`Error deleting defence channel ${defenceChannel.id}:`, error);
                        }
                    }, 2 * 60 * 60 * 1000); // 2 hours
                } catch (error) {
                    console.error('Error in collector end handler:', error);
                }
            });

            if (cropAmount) {
                const cropChannelName = `crop-${villageIdentifier}-${date}`;
                try {
                    const cropChannel = await interaction.guild.channels.create({
                        name: cropChannelName,
                        type: 0,
                        parent: defenceConfig.channels.cropCategory,
                        permissionOverwrites: [
                            {
                                id: interaction.guild.id,
                                deny: [PermissionsBitField.Flags.ViewChannel],
                            },
                            ...defenceConfig.viewRoles.map(roleId => ({
                                id: roleId,
                                allow: [
                                    PermissionsBitField.Flags.ViewChannel,
                                    PermissionsBitField.Flags.SendMessages,
                                    PermissionsBitField.Flags.ReadMessageHistory
                                ]
                            }))
                        ]
                    });

                    // Now cropChannel is defined, so log here:
                    console.log('[CROP DEBUG] About to send crop message:', {
                        cropAmount,
                        x,
                        y,
                        cropChannelName,
                        channelId: cropChannel.id
                    });

                    await cropChannel.send({
                        content: `${defenceConfig.pingRoles.map(role => `<@&${role}>`).join(' ')} Crop request: **${cropAmount}** crop at (**${x}**, **${y}**)
🌍 https://united.x3.balkans.travian.com/karte.php?x=${x}&y=${y}`,
                        allowedMentions: { roles: defenceConfig.pingRoles }
                    });
                    console.log('[CROP DEBUG] Crop message sent successfully to channel:', cropChannel.id);

                    // Add crop channel to tracking
                    addDefenceChannel({
                        channelId: cropChannel.id,
                        type: 'crop',
                        amount: cropAmount,
                        time: null,
                        createdAt: Date.now(),
                        expiresAt: Date.now() + 2 * 60 * 60 * 1000 // 2 hours
                    });

                    // Create collector for crop channel
                    const cropCollector = cropChannel.createMessageCollector();
                    cropCollector.on('collect', async message => {
                        const match = message.content.match(/(\d+(?:\.\d+)?)(k|K|m|M)?\s*\/\s*(\d+(?:\.\d+)?)(k|K|m|M)?/);
                        if (match) {
                            let number = parseFloat(match[1]);
                            const firstSuffix = match[2]?.toLowerCase();
                            if (firstSuffix === 'k') number *= 1000;
                            else if (firstSuffix === 'm') number *= 1000000;

                            if (match[3]) {
                                let targetNumber = parseFloat(match[3]);
                                const secondSuffix = match[4]?.toLowerCase();
                                if (secondSuffix === 'k') targetNumber *= 1000;
                                else if (secondSuffix === 'm') targetNumber *= 1000000;

                                if (Math.round(number) === Math.round(targetNumber) && Math.round(number) === cropAmount) {
                                    // Lock the channel for all roles
                                    for (const roleId of DEFENCE_VIEW_ROLE) {
                                        await cropChannel.permissionOverwrites.edit(roleId, {
                                            SendMessages: false
                                        });
                                    }
                                    
                                    await cropChannel.send('✅ **Crop request completed. Channel will be deleted in 2 hours** / Ολοκληρώθηκε το αίτημα σιταριού. Το κανάλι θα διαγραφεί σε 2 ώρες.');
                                    setTimeout(async () => {
                                        try { await cropChannel.delete(); } catch {}
                                        removeDefenceChannel(cropChannel.id);
                                    }, 2 * 60 * 60 * 1000);
                                    cropCollector.stop();
                                }
                            }
                        }
                    });
                } catch (err) {
                    console.error('Error creating crop channel:', err);
                }
            }

        } catch (err) {
            console.error('❌ Error creating defence channel:', err);
            await interaction.reply({
                content: '❌ Failed to create the defence call channel. / Αποτυχία δημιουργίας καναλιού κλήσης άμυνας.',
                ephemeral: true
            });
        }
    }

    if (interaction.commandName === 'config') {
        // Check if user has admin permissions
        if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
            return await interaction.reply({
                content: '❌ You need administrator permissions to use this command.',
                ephemeral: true
            });
        }

        const subcommand = interaction.options.getSubcommand();

        if (subcommand === 'view') {
            const config = getServerConfig(interaction.guild.id);
            if (!config) {
                return await interaction.reply({
                    content: '❌ No configuration found for this server. Use `/config set` to configure.',
                    ephemeral: true
                });
            }

            const embed = new EmbedBuilder()
                .setTitle('🛡️ Defence Call Configuration')
                .setColor(0x00AE86)
                .addFields(
                    { name: 'Category', value: `<#${config.parentCategory}>`, inline: true },
                    { name: 'View Roles', value: config.viewRoles.map(id => `<@&${id}>`).join('\n'), inline: true },
                    { name: 'Ping Roles', value: config.pingRoles.map(id => `<@&${id}>`).join('\n'), inline: true },
                    { name: 'Log Channel', value: `<#${config.logChannel}>`, inline: true },
                    { name: 'Initiator Log', value: `<#${config.initiatorLogChannel}>`, inline: true }
                );

            await interaction.reply({ embeds: [embed], ephemeral: true });
        }

        if (subcommand === 'set') {
            const category = interaction.options.getChannel('category');
            const viewRole = interaction.options.getRole('view_role');
            const pingRole = interaction.options.getRole('ping_role');
            const logChannel = interaction.options.getChannel('log_channel');
            const initiatorLog = interaction.options.getChannel('initiator_log');

            // Validate channel types
            if (category.type !== 4) {
                return await interaction.reply({
                    content: '❌ The category option must be a category channel.',
                    ephemeral: true
                });
            }

            if (logChannel.type !== 0 || initiatorLog.type !== 0) {
                return await interaction.reply({
                    content: '❌ Log channels must be text channels.',
                    ephemeral: true
                });
            }

            // Initialize server config if it doesn't exist
            if (!serverConfig.servers[interaction.guild.id]) {
                serverConfig.servers[interaction.guild.id] = {};
            }

            // Update configuration
            serverConfig.servers[interaction.guild.id].defenceConfig = {
                viewRoles: [viewRole.id],
                pingRoles: [pingRole.id],
                parentCategory: category.id,
                logChannel: logChannel.id,
                initiatorLogChannel: initiatorLog.id
            };

            // Save configuration
            saveConfig();

            await interaction.reply({
                content: '✅ Defence call configuration updated successfully!',
                ephemeral: true
            });
        }
    }
});

client.on('interactionCreate', async interaction => {
    if (!interaction.isButton()) return;
    const [action, x, y] = interaction.customId.split('_');

    if (action === 'village') {
        const link = `https://united.x3.balkans.travian.com/karte.php?x=${x}&y=${y}`;
        await interaction.deferUpdate();
        await interaction.followUp({ content: `🌍 Travian map link: ${link}`, ephemeral: false });
    }

    if (action === 'page') {
        const page = parseInt(x);
        await sendVillagePage(interaction, page, true);
    }
});

async function sendVillagePage(interaction, page, isUpdate = false) {
    const data = playerVillagePages.get(interaction.user.id);
    if (!data) return;

    const villages = data.pages[page];
    const tribeName = data.tribe;
    const player = data.player;

    const description = `🛡️ Tribe: **${tribeName}** / Φυλή: **${tribeName}**\n\n` +
        villages.map(v =>
            `**${v.villageName}** — (${v.x}, ${v.y}) ${v.isCapital ? '🏰 Capital / Πρωτεύουσα' : ''}`
        ).join('\n');

    const embed = new EmbedBuilder()
        .setTitle(`🏘️ Villages of ${player} / Χωριά του ${player}`)
        .setDescription(description)
        .setColor(0x00AE86)
        .setFooter({ text: `Page ${page + 1} of ${data.pages.length} / Σελίδα ${page + 1} από ${data.pages.length}` });

    const buttonRow = new ActionRowBuilder();
    villages.slice(0, 5).forEach(v => {
        buttonRow.addComponents(
            new ButtonBuilder()
                .setCustomId(`village_${v.x}_${v.y}`)
                .setLabel(v.villageName.slice(0, 20))
                .setStyle(ButtonStyle.Primary)
        );
    });

    const navRow = new ActionRowBuilder();
    if (page > 0) navRow.addComponents(
        new ButtonBuilder()
            .setCustomId(`page_${page - 1}`)
            .setLabel('⬅️ Prev / Προηγούμενο')
            .setStyle(ButtonStyle.Secondary)
    );
    if (page < data.pages.length - 1) navRow.addComponents(
        new ButtonBuilder()
            .setCustomId(`page_${page + 1}`)
            .setLabel('➡️ Next / Επόμενο')
            .setStyle(ButtonStyle.Secondary)
    );

    const components = [buttonRow];
    if (navRow.components.length) components.push(navRow);

    if (isUpdate) {
        await interaction.update({ embeds: [embed], components });
    } else {
        if (interaction.deferred || interaction.replied) {
            await interaction.followUp({ embeds: [embed], components, ephemeral: true });
        } else {
            await interaction.reply({ embeds: [embed], components });
        }
    }
}

// NEW: Listen for messages in channel 1358052407912693911, translate them, and post the translation in channel 1342076524635095042
client.on('messageCreate', async message => {
    console.log(`Message received in channel ${message.channel.id} from ${message.member?.displayName || message.author.username}: ${message.content}`);
    if (message.author.bot) return;

    const greekChannelId = 'ID';
    const englishChannelId = 'ID';

    const channelMap = {
        [greekChannelId]: {
            sourceLang: 'el',
            targets: [
                { lang: 'en', id: englishChannelId }
            ]
        },
        [englishChannelId]: {
            sourceLang: 'en',
            targets: [
                { lang: 'el', id: greekChannelId }
            ]
        }
    };

    const config = channelMap[message.channel.id];
    if (!config) return;

    const displayName = message.member?.displayName || message.author.username;

    if (message.attachments.size > 0) {
        for (const { lang, id: targetChannelId } of config.targets) {
            try {
                const targetChannel = await client.channels.fetch(targetChannelId);
                const content = message.content || "[Attachment]";

                await targetChannel.send({
                    content: `**${displayName} said:**\n> ${content}`,
                    files: [...message.attachments.values()]
                });

                console.log(`Attachment forwarded to ${lang} channel.`);
            } catch (err) {
                console.error(`Error forwarding attachment to ${lang} channel:`, err);
            }
        }
        return;
    }

    try {
        let originalMessageContent = '';

        if (message.reference?.messageId) {
            const originalMessage = await message.channel.messages.fetch(message.reference.messageId);
            originalMessageContent = originalMessage?.content || '';
        }

        for (const { lang: targetLang, id: targetChannelId } of config.targets) {
            try {
                let translatedOriginalText = '';
                if (originalMessageContent) {
                    const originalTranslationResponse = await fetch("", {
                        method: "POST",
                        body: JSON.stringify({
                            text: originalMessageContent,
                            source: config.sourceLang,
                            target: targetLang
                        }),
                        headers: { "Content-Type": "application/json" }
                    });

                    const originalTranslationData = await originalTranslationResponse.json();
                    translatedOriginalText = originalTranslationData.translatedText;
                }

                const replyTranslationResponse = await fetch("", {
                    method: "POST",
                    body: JSON.stringify({
                        text: message.content,
                        source: config.sourceLang,
                        target: targetLang
                    }),
                    headers: { "Content-Type": "application/json" }
                });

                const replyTranslationData = await replyTranslationResponse.json();
                const translatedReplyText = replyTranslationData.translatedText;

                const targetChannel = await client.channels.fetch(targetChannelId);
                if (targetChannel) {
                    let finalMessage = `**${displayName} said:**\n> ${translatedReplyText}`;
                    if (translatedOriginalText) {
                        finalMessage = `**In reply to:**\n> ${translatedOriginalText}\n\n${finalMessage}`;
                    }
                    await targetChannel.send(finalMessage);
                    console.log(`Translation sent to ${targetLang} channel.`);
                } else {
                    console.log(`Target channel ${targetChannelId} not found!`);
                }
            } catch (error) {
                console.error(`Translation error to ${targetLang}:`, error);
            }
        }
    } catch (error) {
        console.error('Main translation handler error:', error);
    }
});

app.post('/defence', defenceRateLimiter, async (req, res) => {
    const { x, y, amount, time, standing } = req.body;
    const isStanding = standing === true || standing === 'true';
  
    const defenceConfig = getServerConfig('1333494775374024735');
    if (!defenceConfig) {
        return res.status(500).json({ message: 'Server configuration not found.' });
    }

    const GUILD_ID = 'guildid';
    const LOG_CHANNEL_ID = defenceConfig.channels.logChannel;
    const DEFENSE_INITIATOR_LOG_CHANNEL_ID = defenceConfig.channels.initiatorLogChannel;
  
    // Using global.latestVillageData if available
    const latestVillageData = global.latestVillageData || [];
  
    try {
      if (!isStanding && !time) {
        return res.status(400).json({ message: '❌ Time is required for normal defence calls.' });
      }
  
      if (!isStanding && time && !/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/.test(time)) {
        return res.status(400).json({ message: '❌ Invalid time format. Use HH:mm in BST.' });
      }

      const guild = client.guilds.cache.get(GUILD_ID);
      if (!guild) return res.status(500).json({ message: 'Guild not found.' });

      // Log who initiated the defense call (API version)
      const defenseLogChannel = guild.channels.cache.get(DEFENSE_INITIATOR_LOG_CHANNEL_ID);
      if (defenseLogChannel) {
        const logMessage = isStanding 
          ? `📢 **API Request** initiated a standing defense call for **${amount}** units at coordinates **(${x}, ${y})**`
          : `📢 **API Request** initiated a defense call for **${amount}** units at coordinates **(${x}, ${y})** for **${time} BST**`;
        defenseLogChannel.send(logMessage);
      }
      
      let attackTime = new Date();
      if (!isStanding && time) {
        const [bstHours, bstMinutes] = time.split(':').map(Number);
        let utcHours = bstHours - 1;
        if (utcHours < 0) {
          utcHours += 24;
          attackTime.setUTCDate(attackTime.getUTCDate() - 1);
        }
        attackTime.setUTCHours(utcHours, bstMinutes, 0, 0);
        if (attackTime < new Date()) {
          attackTime.setUTCDate(attackTime.getUTCDate() + 1);
        }
      }
      const date = attackTime.toISOString().split('T')[0];
  
      const village = latestVillageData.find(v => v.x === x && v.y === y);
      console.log('Looking for x,y =', x, y, 'in latestVillageData...');
      if (!village) {
          console.log('No matching village found for these coords!');
        } else {
          console.log('Found village:', village);
        }    
      const playerName = village ? village.playerName.replace(/[^a-zA-Z0-9]/g, '') : 'unknown';
      const channelName = isStanding ? `standing-def-${playerName}-${date}` : `def-${playerName}-${date}`;
  
      const defenceConfig = getServerConfig(interaction.guild.id);
      if (!defenceConfig) {
          return res.status(500).json({ message: 'Defence call configuration not found.' });
      }
  
      const defenceChannel = await guild.channels.create({
        name: channelName,
        type: 0,
        parent: defenceConfig.parentCategory,
        permissionOverwrites: [
          {
            id: guild.id,
            deny: [PermissionsBitField.Flags.ViewChannel]
          },
          ...defenceConfig.viewRoles.map(roleId => ({
            id: roleId,
            allow: [
              PermissionsBitField.Flags.ViewChannel,
              PermissionsBitField.Flags.SendMessages,
              PermissionsBitField.Flags.ReadMessageHistory
            ]
          }))
        ]
      });
  
      await defenceChannel.send({
        content: `${defenceConfig.pingRoles.map(r => `<@&${r}>`).join(' ')} Defence request: **${amount}** units at (**${x}**, **${y}**)${!isStanding ? `\n🕒 Attack time: **${time} BST**` : ''}
🌍 https://united.x3.balkans.travian.com/karte.php?x=${x}&y=${y}`,
        allowedMentions: { roles: defenceConfig.pingRoles }
      });
  
      if (!isStanding) {
        const notifications = [
          { minutes: 60, message: "1h till attack" },
          { minutes: 30, message: "30 minutes till attack" },
          { minutes: 15, message: "15 minutes till attack" },
          { minutes: 5, message: "5 minutes till attack" }
        ];
        const now = new Date();
        notifications.forEach(({ minutes, message }) => {
          const notifyAt = new Date(attackTime.getTime() - minutes * 60000);
          const delay = notifyAt - now;
          if (delay > 0) {
            setTimeout(() => {
              defenceChannel.send({
                content: `${defenceConfig.pingRoles.map(r => `<@&${r}>`).join(' ')} **${message}**`,
                allowedMentions: { roles: defenceConfig.pingRoles }
              }).catch(console.error);
            }, delay);
          }
        });
      }
  
      const logChannel = guild.channels.cache.get(LOG_CHANNEL_ID);
      if (logChannel) {
        const logMsg = isStanding
          ? `<@&1347607317071532082> Standing def to (${x}, ${y}) ${amount} units`
          : `<@&1347607317071532082> Defence to (${x}, ${y}) ${amount} units at ${time} BST`;
        logChannel.send(logMsg);
      }
  
      // ---- Added locking mechanism via a message collector ----
      if (!isStanding) {
        // Non-standing defence: wait for a matching "call complete" message.
        const collector = defenceChannel.createMessageCollector();
        collector.on('collect', async message => {
          const match = message.content.match(/(\d+(?:\.\d+)?)(k|K|m|M)?\s*\/\s*(\d+(?:\.\d+)?)(k|K|m|M)?/);
          if (match) {
            let number = parseFloat(match[1]);
            const firstSuffix = match[2]?.toLowerCase();
            if (firstSuffix === 'k') number *= 1000;
            else if (firstSuffix === 'm') number *= 1000000;
  
            if (match[3]) {
              let targetNumber = parseFloat(match[3]);
              const secondSuffix = match[4]?.toLowerCase();
              if (secondSuffix === 'k') targetNumber *= 1000;
              else if (secondSuffix === 'm') targetNumber *= 1000000;
  
              if (Math.round(number) === Math.round(targetNumber) && Math.round(number) === amount) {
                // Record the submission for normal defence only
                if (!defenceSubmissions[defenceChannel.id]) defenceSubmissions[defenceChannel.id] = [];
                const submission = {
                    units: Math.round(number),
                    time: time, // from the API context
                    userId: message.author.id,
                    username: message.member?.displayName || message.author.username,
                    submittedAt: new Date().toISOString(),
                    coordinates: { x, y },
                    channelId: defenceChannel.id
                };
                console.log('Adding new submission:', submission);
                defenceSubmissions[defenceChannel.id].push(submission);
                saveDefenceSubmissions();
                
                // Lock the channel for all roles
                for (const roleId of DEFENCE_VIEW_ROLE) {
                    await defenceChannel.permissionOverwrites.edit(roleId, {
                        SendMessages: false
                    });
                }
                
                await defenceChannel.send('✅ **Def call ended. Channel will be deleted in 2 hours** / Ολοκληρώθηκε η κλήση άμυνας. Το κανάλι θα διαγραφεί σε 2 ώρες.');
                setTimeout(async () => {
                    try { await defenceChannel.delete(); } catch {}
                  removeDefenceChannel(defenceChannel.id);
                }, 7200000);
                collector.stop();
              }
            }
          }
        });
      } else {
        // Standing defence: attach a collector and lock the channel once the call is complete.
        const collector = defenceChannel.createMessageCollector();
        const creationTime = Date.now();
        const deletionTime = creationTime + 86400000;
        collector.on('collect', async message => {
          const match = message.content.match(/(\d+(?:\.\d+)?)(k|K|m|M)?\s*\/\s*(\d+(?:\.\d+)?)(k|K|m|M)?/);
          if (match) {
            let number = parseFloat(match[1]);
            const firstSuffix = match[2]?.toLowerCase();
            if (firstSuffix === 'k') number *= 1000;
            else if (firstSuffix === 'm') number *= 1000000;
  
            if (match[3]) {
              let targetNumber = parseFloat(match[3]);
              const secondSuffix = match[4]?.toLowerCase();
              if (secondSuffix === 'k') targetNumber *= 1000;
              else if (secondSuffix === 'm') targetNumber *= 1000000;
  
              if (Math.round(number) === Math.round(targetNumber) && Math.round(number) === amount) {
                const remainingTime = Math.ceil((deletionTime - Date.now()) / 3600000);
                await defenceChannel.send(`✅ **Standing def completed, will be deleted in ${remainingTime} hours** / Ολοκληρώθηκε η σταθερή άμυνα, θα διαγραφεί σε ${remainingTime} ώρες.`);
                // Lock the channel for all roles
                for (const roleId of DEFENCE_VIEW_ROLE) {
                  await defenceChannel.permissionOverwrites.edit(roleId, {
                    SendMessages: false
                  });
                }
                collector.stop();
              }
            }
          }
        });
        // Schedule deletion after 24 hours
        setTimeout(async () => {
          try {
            await defenceChannel.send('⏰ **Standing defence expired. Channel will now be deleted.** / Έληξε ο χρόνος για την σταθερή άμυνα. Το κανάλι θα διαγραφεί τώρα.');
            await defenceChannel.delete();
          } catch (err) {
            console.error(`Failed to delete standing defence channel: ${err}`);
          }
          removeDefenceChannel(defenceChannel.id);
        }, 86400000);
      }
  
      res.status(200).json({ message: `✅ Created defence channel: ${defenceChannel.name}` });
    } catch (err) {
      console.error(err);
      res.status(500).json({ message: '❌ Failed to create defence channel.' });
    }
  });

  
// Add these constants at the top with your other constants
const JWT_SECRET = 'token'; // Change this to a secure secret
const otpStore = new Map(); // Store OTP codes temporarily

  // Add the verify endpoint
  app.post('/verify', async (req, res) => {
    const { serverName, otp } = req.body;
    const guildId = '1333494775374024735';
    const guild = client.guilds.cache.get(guildId);

    if (!guild) {
        return res.status(404).json({ message: 'Server not found' });
    }

    try {
        // Handle OTP submission
        if (otp) {
            const storedData = otpStore.get(serverName);
            if (!storedData || storedData.otp !== otp) {
                return res.status(400).json({ message: 'Invalid OTP' });
            }

            const token = jwt.sign(
                {
                    serverName,
                    userId: storedData.userId,
                    exp: Math.floor(Date.now() / 1000) + (48 * 60 * 60) // 48 hours
                },
                JWT_SECRET
            );

            otpStore.delete(serverName);
            return res.json({ token });
        }

        console.log(`🔍 Looking for serverName: "${serverName.toLowerCase()}"`);

        // Try cached members first
        let member = guild.members.cache.find(m =>
            m.displayName.toLowerCase() === serverName.toLowerCase() ||
            m.user.username.toLowerCase() === serverName.toLowerCase()
        );

        // If not found, try fetching up to 10 by query
        if (!member) {
            const fetchedMembers = await guild.members.fetch({ query: serverName, limit: 10 });
            member = fetchedMembers.find(m =>
                m.displayName.toLowerCase() === serverName.toLowerCase() ||
                m.user.username.toLowerCase() === serverName.toLowerCase()
            );
        }

        if (!member) {
            return res.status(404).json({
                message: 'User not found in server',
                searchedFor: serverName.toLowerCase(),
                memberCount: guild.members.cache.size
            });
        }

        // ✅ Restrict OTP access based on allowed roles
        const hasAllowedRole = member.roles.cache.some(role => ALLOWED_COMMAND_ROLES.includes(role.id));
        if (!hasAllowedRole) {
            return res.status(403).json({
                message: '❌ You are not authorized to use verification. Contact your leadership.'
            });
        }

        // Generate OTP
        const generatedOTP = Math.random().toString(36).substring(2, 8).toUpperCase();
        otpStore.set(serverName, {
            otp: generatedOTP,
            userId: member.id,
            timestamp: Date.now()
        });

        try {
            await member.send(`🔐 Your verification OTP is: **${generatedOTP}**\nThis code will expire in 5 minutes.`);
            console.log(`✅ OTP sent successfully to ${member.displayName}`);
        } catch (dmError) {
            console.error(`❌ Failed to send DM to ${member.displayName}:`, dmError);
            return res.status(400).json({
                message: 'Unable to send DM. Please ensure your DMs are open for this server.'
            });
        }

        // Clean up OTP after 5 minutes
        setTimeout(() => {
            if (otpStore.has(serverName)) {
                otpStore.delete(serverName);
                console.log(`🧹 Cleaned up expired OTP for ${serverName}`);
            }
        }, 300000); // 5 minutes

        res.json({ message: '✅ OTP sent to your Discord DM' });

    } catch (error) {
        console.error('Verification error:', error);
        res.status(500).json({
            message: 'Verification failed',
            error: error.message
        });
    }
});

// Update the defence submissions endpoint
app.get('/defence-submissions', (req, res) => {
    try {
        // Format the submissions for display
        const formattedSubmissions = Object.entries(defenceSubmissions)
            .filter(([_, submissions]) => submissions && submissions.length > 0)
            .map(([channelId, submissions]) => {
                const latestSubmission = submissions[submissions.length - 1];
                if (!latestSubmission) return null;
                
                const initialSubmission = submissions.find(s => s.isInitial);
                
                return {
                    channelId,
                    coordinates: latestSubmission.coordinates || { x: 0, y: 0 },
                    amount: latestSubmission.units || 0,
                    time: latestSubmission.time || 'N/A',
                    type: latestSubmission.type || 'unknown',
                    submittedBy: latestSubmission.username || 'Unknown',
                    submittedAt: latestSubmission.submittedAt || new Date().toISOString(),
                    totalSubmissions: submissions.length,
                    initialRequest: initialSubmission ? {
                        amount: initialSubmission.units,
                        time: initialSubmission.time,
                        submittedBy: initialSubmission.username,
                        submittedAt: initialSubmission.submittedAt
                    } : null
                };
            })
            .filter(submission => submission !== null);

        res.json({
            totalChannels: formattedSubmissions.length,
            submissions: formattedSubmissions,
            rawData: defenceSubmissions // Include raw data for debugging
        });
    } catch (error) {
        console.error('Error formatting defence submissions:', error);
        res.status(500).json({
            error: 'Failed to format defence submissions',
            details: error.message
        });
    }
});

app.listen(1759, '0.0.0.0', () => {
    console.log('Server running on port 1759');
});

client.login(token).then(() => {
    const now = new Date();
    console.log('=== TIME DEBUG INFO ===');
    console.log(`Current time (local): ${now.toString()}`);
    console.log(`Current time (UTC/GMT+0): ${now.toUTCString()}`);
    console.log(`Current UTC hours: ${now.getUTCHours()}, minutes: ${now.getUTCMinutes()}`);
    console.log('======================');
});

