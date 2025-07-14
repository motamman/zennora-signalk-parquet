const fs = require('fs-extra');
const path = require('path');
const ParquetWriter = require('./parquet-writer');

// AWS S3 for file upload
let S3Client, PutObjectCommand;
try {
  const { S3Client: S3ClientClass, PutObjectCommand: PutObjectCommandClass } = require('@aws-sdk/client-s3');
  S3Client = S3ClientClass;
  PutObjectCommand = PutObjectCommandClass;
} catch (error) {
  console.warn('AWS S3 SDK not available for file uploads');
}

// DuckDB for webapp queries
let DuckDBInstance;
try {
  const duckdb = require('@duckdb/node-api');
  DuckDBInstance = duckdb.DuckDBInstance;
} catch (error) {
  console.warn('DuckDB not available for webapp queries');
}

module.exports = function(app) {
  let plugin = {};
  let unsubscribes = [];
  let dataBuffers = new Map(); // Store buffers by SignalK path
  let activeRegimens = new Set(); // Track active regimen states
  let subscribedPaths = new Set(); // Track currently subscribed SignalK paths
  let saveInterval;
  let consolidationInterval;
  let parquetWriter;
  let s3Client;
  let currentConfig; // Store current configuration

  plugin.id = 'zennora-signalk-parquet';
  plugin.name = 'Zennora SignalK to Parquet';
  plugin.description = 'Save SignalK marine data directly to Parquet files with regimen-based control';

  plugin.start = function(options) {
    app.debug('Starting Zennora SignalK to Parquet plugin');

    // Get vessel MMSI from SignalK
    const vesselMMSI = app.getSelfPath('mmsi') || app.getSelfPath('name') || 'unknown_vessel';
    
    // Use SignalK's application data directory
    const defaultOutputDir = path.join(app.getDataDirPath(), 'zennora-signalk-parquet');
    
    currentConfig = {
      bufferSize: options?.bufferSize || 1000,
      saveIntervalSeconds: options?.saveIntervalSeconds || 30,
      outputDirectory: options?.outputDirectory || defaultOutputDir,
      filenamePrefix: options?.filenamePrefix || 'signalk_data',
      retentionDays: options?.retentionDays || 7,
      fileFormat: options?.fileFormat || 'parquet', // 'json', 'csv', or 'parquet'
      vesselMMSI: vesselMMSI,
      paths: options?.paths || getDefaultPaths(),
      s3Upload: options?.s3Upload || { enabled: false }
    };

    // Initialize ParquetWriter
    parquetWriter = new ParquetWriter({ format: currentConfig.fileFormat });

    // Initialize S3 client if enabled
    if (currentConfig.s3Upload.enabled && S3Client) {
      try {
        const s3Config = {
          region: currentConfig.s3Upload.region || 'us-east-1'
        };
        
        // Add credentials if provided
        if (currentConfig.s3Upload.accessKeyId && currentConfig.s3Upload.secretAccessKey) {
          s3Config.credentials = {
            accessKeyId: currentConfig.s3Upload.accessKeyId,
            secretAccessKey: currentConfig.s3Upload.secretAccessKey
          };
        }
        
        s3Client = new S3Client(s3Config);
        app.debug('S3 client initialized for bucket:', currentConfig.s3Upload.bucket);
      } catch (error) {
        app.debug('Error initializing S3 client:', error);
        s3Client = null;
      }
    }

    // Ensure output directory exists
    fs.ensureDirSync(currentConfig.outputDirectory);

    // Subscribe to command paths first (these control regimens)
    subscribeToCommandPaths(currentConfig);

    // Check current command values at startup
    initializeRegimenStates(currentConfig);

    // Subscribe to data paths based on initial regimen states
    updateDataSubscriptions(currentConfig);

    // Set up periodic save
    saveInterval = setInterval(() => {
      saveAllBuffers(currentConfig);
    }, currentConfig.saveIntervalSeconds * 1000);

    // Set up daily consolidation (run at midnight UTC)
    const now = new Date();
    const nextMidnightUTC = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0, 0));
    const msUntilMidnightUTC = nextMidnightUTC.getTime() - now.getTime();
    
    app.debug(`Next consolidation at ${nextMidnightUTC.toISOString()} (in ${Math.round(msUntilMidnightUTC / 1000 / 60)} minutes)`);
    
    setTimeout(() => {
      consolidateYesterday(currentConfig);
      
      // Then run daily consolidation every 24 hours
      consolidationInterval = setInterval(() => {
        consolidateYesterday(currentConfig);
      }, 24 * 60 * 60 * 1000);
    }, msUntilMidnightUTC);


    app.debug('Zennora SignalK to Parquet plugin started');
  };

  plugin.stop = function() {
    app.debug('Stopping Zennora SignalK to Parquet plugin');
    
    // Clear intervals
    if (saveInterval) {
      clearInterval(saveInterval);
    }
    if (consolidationInterval) {
      clearInterval(consolidationInterval);
    }

    // Save any remaining buffered data
    saveAllBuffers();

    // Unsubscribe from all paths
    unsubscribes.forEach(unsubscribe => {
      if (typeof unsubscribe === 'function') {
        unsubscribe();
      }
    });
    unsubscribes = [];
    
    // Clear data structures
    dataBuffers.clear();
    activeRegimens.clear();
    subscribedPaths.clear();
  };

  // Subscribe to command paths that control regimens using proper subscription manager
  function subscribeToCommandPaths(config) {
    const commandPaths = config.paths.filter(pathConfig => 
      pathConfig && pathConfig.path && pathConfig.path.startsWith('commands.') && pathConfig.enabled
    );

    if (commandPaths.length === 0) return;

    const commandSubscription = {
      context: 'vessels.self',
      subscribe: commandPaths.map(pathConfig => ({
        path: pathConfig.path,
        period: 1000  // Check commands every second
      }))
    };

    app.debug(`Subscribing to ${commandPaths.length} command paths via subscription manager`);

    app.subscriptionmanager.subscribe(
      commandSubscription,
      unsubscribes,
      (subscriptionError) => {
        app.debug('Command subscription error:', subscriptionError);
      },
      (delta) => {
        // Process each update in the delta
        if (delta.updates) {
          delta.updates.forEach((update) => {
            if (update.values) {
              update.values.forEach((valueUpdate) => {
                const pathConfig = commandPaths.find(p => p.path === valueUpdate.path);
                if (pathConfig) {
                  handleCommandMessage(valueUpdate, pathConfig, config, update);
                }
              });
            }
          });
        }
      }
    );

    commandPaths.forEach(pathConfig => {
      subscribedPaths.add(pathConfig.path);
    });
  }

  // Handle command messages (regimen control) - now receives complete delta structure
  function handleCommandMessage(valueUpdate, pathConfig, config, update) {
    try {
      app.debug(`📦 Received command update for ${pathConfig.path}:`, JSON.stringify(valueUpdate, null, 2));
      
      // Check source filter if specified for commands too
      if (pathConfig.source && pathConfig.source.trim() !== '') {
        const messageSource = update.$source || (update.source ? update.source.label : null);
        if (messageSource !== pathConfig.source.trim()) {
          app.debug(`🚫 Command from source "${messageSource}" filtered out (expecting "${pathConfig.source.trim()}")`);
          return;
        }
      }
      
      if (valueUpdate.value !== undefined) {
        const commandName = extractCommandName(pathConfig.path);
        const isActive = Boolean(valueUpdate.value);
        
        app.debug(`Command ${commandName}: ${isActive ? 'ACTIVE' : 'INACTIVE'}`);
        
        if (isActive) {
          activeRegimens.add(commandName);
        } else {
          activeRegimens.delete(commandName);
        }
        
        // Debug active regimens state
        app.debug(`🎯 Active regimens: [${Array.from(activeRegimens).join(', ')}]`);
        
        // Update data subscriptions based on new regimen state
        updateDataSubscriptions(config);
        
        // Buffer this command change with complete metadata
        const bufferKey = `${pathConfig.context || 'vessels.self'}:${pathConfig.path}`;
        bufferData(bufferKey, {
          received_timestamp: new Date().toISOString(),
          signalk_timestamp: update.timestamp,
          context: 'vessels.self',
          path: valueUpdate.path,
          value: valueUpdate.value,
          source: update.source ? JSON.stringify(update.source) : null,
          source_label: update.$source || (update.source ? update.source.label : null),
          source_type: update.source ? update.source.type : null,
          source_pgn: update.source ? update.source.pgn : null,
          source_src: update.source ? update.source.src : null,
          meta: valueUpdate.meta ? JSON.stringify(valueUpdate.meta) : null
        }, config);
      }
    } catch (error) {
      app.debug('Error handling command message:', error);
    }
  }

  // Update data path subscriptions based on active regimens
  function updateDataSubscriptions(config) {
    const dataPaths = config.paths.filter(pathConfig => 
      pathConfig && pathConfig.path && !pathConfig.path.startsWith('commands.')
    );

    const shouldSubscribePaths = dataPaths.filter(pathConfig => shouldSubscribeToPath(pathConfig));
    
    if (shouldSubscribePaths.length === 0) {
      app.debug('No data paths need subscription currently');
      return;
    }

    // Group paths by context for separate subscriptions
    const contextGroups = new Map();
    shouldSubscribePaths.forEach(pathConfig => {
      const context = pathConfig.context || 'vessels.self';
      if (!contextGroups.has(context)) {
        contextGroups.set(context, []);
      }
      contextGroups.get(context).push(pathConfig);
    });

    // Create subscriptions for each context group
    contextGroups.forEach((pathConfigs, context) => {
      const dataSubscription = {
        context: context,
        subscribe: pathConfigs.map(pathConfig => ({
          path: pathConfig.path,
          period: 1000  // Get updates every second max
        }))
      };

      app.debug(`Subscribing to ${pathConfigs.length} data paths for context ${context}`);

      app.subscriptionmanager.subscribe(
        dataSubscription,
        unsubscribes,
        (subscriptionError) => {
          app.debug(`Data subscription error for ${context}:`, subscriptionError);
        },
        (delta) => {
          // Process each update in the delta
          if (delta.updates) {
            delta.updates.forEach((update) => {
              if (update.values) {
                update.values.forEach((valueUpdate) => {
                  const pathConfig = pathConfigs.find(p => p.path === valueUpdate.path);
                  if (pathConfig) {
                    handleDataMessage(valueUpdate, pathConfig, config, update, delta);
                  }
                });
              }
            });
          }
        }
      );

      pathConfigs.forEach(pathConfig => {
        subscribedPaths.add(pathConfig.path);
      });
    });
  }

  // Determine if we should subscribe to a path based on regimens
  function shouldSubscribeToPath(pathConfig) {
    // Always subscribe if explicitly enabled
    if (pathConfig.enabled) {
      app.debug(`✅ Path ${pathConfig.path} enabled (always on)`);
      return true;
    }

    // Check if any required regimens are active
    if (pathConfig.regimen) {
      const requiredRegimens = pathConfig.regimen.split(',').map(r => r.trim());
      const hasActiveRegimen = requiredRegimens.some(regimen => activeRegimens.has(regimen));
      app.debug(`🔍 Path ${pathConfig.path} requires regimens [${requiredRegimens.join(', ')}], active: [${Array.from(activeRegimens).join(', ')}] → ${hasActiveRegimen ? 'SUBSCRIBE' : 'SKIP'}`);
      return hasActiveRegimen;
    }

    app.debug(`❌ Path ${pathConfig.path} has no regimen control and not enabled`);
    return false;
  }

  // Handle data messages from SignalK - now receives complete delta structure
  function handleDataMessage(valueUpdate, pathConfig, config, update, delta) {
    try {
      // Check if we should still process this path
      if (!shouldSubscribeToPath(pathConfig)) {
        return;
      }

      // Check source filter if specified
      if (pathConfig.source && pathConfig.source.trim() !== '') {
        const messageSource = update.$source || (update.source ? update.source.label : null);
        if (messageSource !== pathConfig.source.trim()) {
          // Source doesn't match filter, skip this message
          return;
        }
      }

      const record = {
        received_timestamp: new Date().toISOString(),
        signalk_timestamp: update.timestamp,
        context: delta.context || pathConfig.context || 'vessels.self', // Use actual context from delta message
        path: valueUpdate.path,
        value: null,
        value_json: null,
        source: update.source ? JSON.stringify(update.source) : null,
        source_label: update.$source || (update.source ? update.source.label : null),
        source_type: update.source ? update.source.type : null,
        source_pgn: update.source ? update.source.pgn : null,
        source_src: update.source ? update.source.src : null,
        meta: valueUpdate.meta ? JSON.stringify(valueUpdate.meta) : null
      };

      // Handle different value types (matching Python logic)
      if (typeof valueUpdate.value === 'object' && valueUpdate.value !== null) {
        record.value_json = JSON.stringify(valueUpdate.value);
        
        // Flatten object properties for easier querying
        for (const [key, val] of Object.entries(valueUpdate.value)) {
          if (typeof val === 'string' || typeof val === 'number' || typeof val === 'boolean') {
            record[`value_${key}`] = val;
          }
        }
      } else {
        record.value = valueUpdate.value;
      }

      // Use actual context + path as buffer key to separate data from different vessels
      const actualContext = delta.context || pathConfig.context || 'vessels.self';
      
      const bufferKey = `${actualContext}:${pathConfig.path}`;
      bufferData(bufferKey, record, config);

    } catch (error) {
      app.debug('Error handling data message:', error);
    }
  }

  // Buffer data and trigger save if buffer is full
  function bufferData(signalkPath, record, config) {
    if (!dataBuffers.has(signalkPath)) {
      dataBuffers.set(signalkPath, []);
      app.debug(`🆕 Created new buffer for path: ${signalkPath}`);
    }
    
    const buffer = dataBuffers.get(signalkPath);
    buffer.push(record);
    
    // Debug every 100 records to show buffer growth
    if (buffer.length % 100 === 0) {
      app.debug(`📊 Buffer for ${signalkPath}: ${buffer.length}/${config.bufferSize} records`);
    }
    
    if (buffer.length >= config.bufferSize) {
      app.debug(`🚀 Buffer full for ${signalkPath} (${buffer.length} records) - triggering save`);
      // Extract the actual SignalK path from the buffer key (context:path format)
      // Find the separator between context and path - look for the last colon followed by a valid SignalK path
      const pathMatch = signalkPath.match(/^.*:([a-zA-Z][a-zA-Z0-9._]*)$/);
      const actualPath = pathMatch ? pathMatch[1] : signalkPath;
      saveBufferToParquet(actualPath, buffer, config);
      dataBuffers.set(signalkPath, []); // Clear buffer
      app.debug(`🧹 Buffer cleared for ${signalkPath}`);
    }
  }

  // Save all buffers (called periodically and on shutdown)
  function saveAllBuffers(config) {
    const totalBuffers = dataBuffers.size;
    let buffersWithData = 0;
    let totalRecords = 0;
    
    dataBuffers.forEach((buffer, signalkPath) => {
      if (buffer.length > 0) {
        buffersWithData++;
        totalRecords += buffer.length;
        app.debug(`⏰ Periodic save for ${signalkPath}: ${buffer.length} records`);
        // Extract the actual SignalK path from the buffer key (context:path format)
        // Find the separator between context and path - look for the last colon followed by a valid SignalK path
        const pathMatch = signalkPath.match(/^.*:([a-zA-Z][a-zA-Z0-9._]*)$/);
        const actualPath = pathMatch ? pathMatch[1] : signalkPath;
        saveBufferToParquet(actualPath, buffer, config);
        dataBuffers.set(signalkPath, []); // Clear buffer
      }
    });
    
    if (buffersWithData > 0) {
      app.debug(`💾 Periodic save completed: ${buffersWithData}/${totalBuffers} paths, ${totalRecords} total records`);
    }
  }

  // Save buffer to Parquet file
  async function saveBufferToParquet(signalkPath, buffer, config) {
    try {
      // Get context from first record in buffer (all records in buffer have same path/context)
      const context = buffer.length > 0 ? buffer[0].context : 'vessels.self';
      
      // Create proper directory structure
      let contextPath;
      if (context === 'vessels.self') {
        contextPath = app.selfContext.replace(/\./g, '/');
      } else if (context.startsWith('vessels.')) {
        // Extract vessel identifier and clean it for filesystem
        const vesselId = context.replace('vessels.', '').replace(/:/g, '_');
        contextPath = `vessels/${vesselId}`;
      } else if (context.startsWith('meteo.')) {
        // Extract meteo station identifier and clean it for filesystem  
        const meteoId = context.replace('meteo.', '').replace(/:/g, '_');
        contextPath = `meteo/${meteoId}`;
      } else {
        // Fallback: clean the entire context
        contextPath = context.replace(/:/g, '_').replace(/\./g, '/');
      }
      
      const dirPath = path.join(config.outputDirectory, contextPath, signalkPath.replace(/\./g, '/'));
      await fs.ensureDir(dirPath);
      
      // Generate filename with timestamp
      const timestamp = new Date().toISOString().replace(/[:.]/g, '').slice(0, 15);
      const fileExt = config.fileFormat === 'csv' ? 'csv' : (config.fileFormat === 'parquet' ? 'parquet' : 'json');
      const filename = `${config.filenamePrefix}_${timestamp}.${fileExt}`;
      const filepath = path.join(dirPath, filename);
      
      // Use ParquetWriter to save in the configured format
      const savedPath = await parquetWriter.writeRecords(filepath, buffer);
      
      app.debug(`💾 Saved ${buffer.length} records to ${path.basename(savedPath)} for path: ${signalkPath}`);
      
      // Upload to S3 if enabled and timing is real-time
      if (config.s3Upload.enabled && config.s3Upload.timing === 'realtime') {
        await uploadToS3(savedPath, config);
      }
      
    } catch (error) {
      app.debug(`❌ Error saving buffer for ${signalkPath}:`, error);
    }
  }

  // Daily consolidation function
  async function consolidateYesterday(config) {
    try {
      const yesterday = new Date();
      yesterday.setUTCDate(yesterday.getUTCDate() - 1);
      
      const consolidatedCount = await parquetWriter.consolidateDaily(
        config.outputDirectory, 
        yesterday, 
        config.filenamePrefix
      );
      
      if (consolidatedCount > 0) {
        app.debug(`Consolidated ${consolidatedCount} topic directories for ${yesterday.toISOString().split('T')[0]}`);
        
        // Upload consolidated files to S3 if enabled and timing is consolidation
        if (config.s3Upload.enabled && config.s3Upload.timing === 'consolidation') {
          await uploadConsolidatedFilesToS3(config, yesterday);
        }
      }
    } catch (error) {
      app.debug('Error during daily consolidation:', error);
    }
  }

  // Upload consolidated files to S3
  async function uploadConsolidatedFilesToS3(config, date) {
    try {
      const dateStr = date.toISOString().split('T')[0];
      const consolidatedPattern = `**/*_${dateStr}_consolidated.parquet`;
      
      // Find all consolidated files for the date
      const { glob } = require('glob');
      const consolidatedFiles = await glob(consolidatedPattern, {
        cwd: config.outputDirectory,
        absolute: true,
        nodir: true
      });
      
      app.debug(`Found ${consolidatedFiles.length} consolidated files to upload for ${dateStr}`);
      
      // Upload each consolidated file
      for (const filePath of consolidatedFiles) {
        await uploadToS3(filePath, config);
      }
      
    } catch (error) {
      app.debug('Error uploading consolidated files to S3:', error);
    }
  }

  // Initialize regimen states from current API values at startup
  function initializeRegimenStates(config) {
    const commandPaths = config.paths.filter(pathConfig => 
      pathConfig && pathConfig.path && pathConfig.path.startsWith('commands.') && pathConfig.enabled
    );

    app.debug(`🔍 Checking current command values for ${commandPaths.length} command paths at startup`);

    commandPaths.forEach(pathConfig => {
      try {
        // Get current value from SignalK API
        const currentData = app.getSelfPath(pathConfig.path);
        
        if (currentData !== undefined && currentData !== null) {
          app.debug(`📋 Found current value for ${pathConfig.path}:`, currentData);
          
          // Check if there's source information
          let shouldProcess = true;
          
          // If source filter is specified, check it
          if (pathConfig.source && pathConfig.source.trim() !== '') {
            // For startup, we need to check the API source info
            // This is a simplified check - in real deltas we get more source info
            app.debug(`🔍 Source filter specified for ${pathConfig.path}: "${pathConfig.source.trim()}"`);
            
            // For now, we'll process the value if it exists and log a warning
            // In practice, you might want to check the source here too
            app.debug(`⚠️  Startup value processed without source verification for ${pathConfig.path}`);
          }
          
          if (shouldProcess && currentData.value !== undefined) {
            const commandName = extractCommandName(pathConfig.path);
            const isActive = Boolean(currentData.value);
            
            app.debug(`🚀 Startup: Command ${commandName}: ${isActive ? 'ACTIVE' : 'INACTIVE'}`);
            
            if (isActive) {
              activeRegimens.add(commandName);
            } else {
              activeRegimens.delete(commandName);
            }
          }
        } else {
          app.debug(`📭 No current value found for ${pathConfig.path}`);
        }
      } catch (error) {
        app.debug(`❌ Error checking startup value for ${pathConfig.path}:`, error);
      }
    });

    app.debug(`🎯 Startup regimens initialized: [${Array.from(activeRegimens).join(', ')}]`);
  }

  // Helper functions
  function extractCommandName(signalkPath) {
    // Extract command name from "commands.captureWeather"
    const parts = signalkPath.split('.');
    return parts[parts.length - 1];
  }

  // S3 upload function
  async function uploadToS3(filePath, config) {
    if (!config.s3Upload.enabled || !s3Client || !PutObjectCommand) {
      return false;
    }

    try {
      // Read the file
      const fileContent = await fs.readFile(filePath);
      
      // Generate S3 key
      const relativePath = path.relative(config.outputDirectory, filePath);
      let s3Key = relativePath;
      if (config.s3Upload.keyPrefix) {
        const prefix = config.s3Upload.keyPrefix.endsWith('/') 
          ? config.s3Upload.keyPrefix 
          : `${config.s3Upload.keyPrefix}/`;
        s3Key = `${prefix}${relativePath}`;
      }

      // Upload to S3
      const command = new PutObjectCommand({
        Bucket: config.s3Upload.bucket,
        Key: s3Key,
        Body: fileContent,
        ContentType: filePath.endsWith('.parquet') ? 'application/octet-stream' : 'application/json'
      });

      await s3Client.send(command);
      app.debug(`✅ Uploaded to S3: s3://${config.s3Upload.bucket}/${s3Key}`);

      // Delete local file if configured
      if (config.s3Upload.deleteAfterUpload) {
        await fs.unlink(filePath);
        app.debug(`🗑️ Deleted local file: ${filePath}`);
      }

      return true;
    } catch (error) {
      app.debug(`❌ Error uploading ${filePath} to S3:`, error);
      return false;
    }
  }




  function getDefaultPaths() {
    // Return default SignalK paths for initial testing
    return [
      {
        name: "Capture Weather Command",
        path: "commands.captureWeather",
        description: "Boolean command to enable weather data capture",
        enabled: true
      },
      {
        name: "Capture Passage Command", 
        path: "commands.capturePassage",
        description: "Boolean command to enable passage data capture",
        enabled: true
      },
      {
        name: "Navigation Position",
        path: "navigation.position",
        description: "GPS position data with latitude, longitude, altitude",
        enabled: false,
        regimen: "capturePassage, captureWeather",
        context: "vessels.self"
      },
      {
        name: "AIS Vessel Positions",
        path: "navigation.position", 
        description: "AIS position data from nearby vessels",
        enabled: false,
        regimen: "capturePassage",
        context: "vessels.*"
      },
      {
        name: "Wind Speed Apparent",
        path: "environment.wind.speedApparent", 
        description: "Apparent wind speed",
        enabled: false,
        regimen: "captureWeather",
        source: ""
      },
      {
        name: "Wind Direction Apparent",
        path: "environment.wind.angleApparent",
        description: "Apparent wind direction", 
        enabled: false,
        regimen: "captureWeather",
        source: ""
      },
      {
        name: "Design Beam",
        path: "design.beam",
        description: "Vessel beam measurement",
        enabled: false,
        regimen: "",
        source: ""
      }
    ];
  }

  plugin.schema = {
    type: 'object',
    properties: {
      bufferSize: {
        type: 'number',
        title: 'Buffer Size',
        description: 'Number of records to buffer before writing to file',
        default: 1000,
        minimum: 10,
        maximum: 10000
      },
      saveIntervalSeconds: {
        type: 'number', 
        title: 'Save Interval (seconds)',
        description: 'How often to save buffered data to files',
        default: 30,
        minimum: 5,
        maximum: 300
      },
      outputDirectory: {
        type: 'string',
        title: 'Output Directory',
        description: 'Directory to save data files (defaults to application_data/{vessel}/zennora-signalk-parquet)',
        default: ''
      },
      filenamePrefix: {
        type: 'string',
        title: 'Filename Prefix', 
        description: 'Prefix for generated filenames',
        default: 'signalk_data'
      },
      fileFormat: {
        type: 'string',
        title: 'File Format',
        description: 'Format for saved data files',
        enum: ['json', 'csv', 'parquet'],
        default: 'parquet'
      },
      retentionDays: {
        type: 'number',
        title: 'Retention Days',
        description: 'Days to keep processed files',
        default: 7,
        minimum: 1,
        maximum: 365
      },
      paths: {
        type: 'array',
        title: 'SignalK Paths',
        description: 'Configure which SignalK paths to collect',
        items: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              title: 'Path Name'
            },
            path: {
              type: 'string', 
              title: 'SignalK Path',
              description: 'Example: navigation.position, design.beam, commands.captureWeather'
            },
            description: {
              type: 'string',
              title: 'Description'
            },
            enabled: {
              type: 'boolean',
              title: 'Always Enabled',
              default: false
            },
            regimen: {
              type: 'string',
              title: 'Regimen Control',
              description: 'Comma-separated list of regimens that enable this path'
            },
            source: {
              type: 'string',
              title: 'Source Filter (Optional)',
              description: 'Only capture data from this specific source (e.g. "mqtt-weatherflow-udp"). Leave empty to capture from all sources.',
              default: ''
            },
            context: {
              type: 'string',
              title: 'Context (Optional)',
              description: 'SignalK context to monitor. Examples: "vessels.self" (default), "vessels.urn:mrn:imo:mmsi:356068000", "vessels.*" (all vessels), "meteo.*" (all meteo stations)',
              default: 'vessels.self'
            }
          }
        }
      },
      s3Upload: {
        type: 'object',
        title: 'S3 Upload Configuration',
        description: 'Optional S3 backup/archive functionality',
        properties: {
          enabled: {
            type: 'boolean',
            title: 'Enable S3 Upload',
            description: 'Enable uploading files to Amazon S3',
            default: false
          },
          timing: {
            type: 'string',
            title: 'Upload Timing',
            description: 'When to upload files to S3',
            enum: ['realtime', 'consolidation'],
            enumNames: ['Real-time (after each file save)', 'At consolidation (daily)'],
            default: 'consolidation'
          },
          bucket: {
            type: 'string',
            title: 'S3 Bucket Name',
            description: 'Name of the S3 bucket to upload to',
            default: ''
          },
          region: {
            type: 'string',
            title: 'AWS Region',
            description: 'AWS region where the S3 bucket is located',
            default: 'us-east-1'
          },
          keyPrefix: {
            type: 'string',
            title: 'S3 Key Prefix',
            description: 'Optional prefix for S3 object keys (e.g., "marine-data/")',
            default: ''
          },
          accessKeyId: {
            type: 'string',
            title: 'AWS Access Key ID',
            description: 'AWS Access Key ID (leave empty to use IAM role or environment variables)',
            default: ''
          },
          secretAccessKey: {
            type: 'string',
            title: 'AWS Secret Access Key',
            description: 'AWS Secret Access Key (leave empty to use IAM role or environment variables)',
            default: ''
          },
          deleteAfterUpload: {
            type: 'boolean',
            title: 'Delete Local Files After Upload',
            description: 'Delete local files after successful upload to S3',
            default: false
          }
        }
      }
    }
  };

  // Webapp static files and API routes
  plugin.registerWithRouter = function(router) {
    const express = require('express');
    
    // Serve static files from public directory
    const publicPath = path.join(__dirname, 'public');
    if (fs.existsSync(publicPath)) {
      router.use(express.static(publicPath));
      app.debug('Static files served from:', publicPath);
    }

    // Get the current configuration for data directory
    const getDataDir = () => {
      // The plugin saves to ~/.signalk/data directly
      return app.getDataDirPath();
    };


    // Helper function to get available paths from directory structure
    function getAvailablePaths(dataDir) {
      const paths = [];
      const selfContextPath = app.selfContext.replace(/\./g, '/');
      const vesselsDir = path.join(dataDir, selfContextPath);
      
      app.debug(`🔍 Looking for paths in vessel directory: ${vesselsDir}`);
      app.debug(`📡 Using vessel context: ${app.selfContext} → ${selfContextPath}`);
      
      if (!fs.existsSync(vesselsDir)) {
        app.debug(`❌ Vessel directory does not exist: ${vesselsDir}`);
        return paths;
      }
      
      function walkPaths(currentPath, relativePath = '') {
        try {
          app.debug(`🚶 Walking path: ${currentPath} (relative: ${relativePath})`);
          const items = fs.readdirSync(currentPath);
          items.forEach(item => {
            const fullPath = path.join(currentPath, item);
            const stat = fs.statSync(fullPath);
            
            if (stat.isDirectory() && item !== 'processed' && item !== 'failed') {
              const newRelativePath = relativePath ? `${relativePath}.${item}` : item;
              
              // Check if this directory has parquet files
              const hasParquetFiles = fs.readdirSync(fullPath).some(file => file.endsWith('.parquet'));
              
              if (hasParquetFiles) {
                const fileCount = fs.readdirSync(fullPath).filter(file => file.endsWith('.parquet')).length;
                app.debug(`✅ Found SignalK path with data: ${newRelativePath} (${fileCount} files)`);
                paths.push({
                  path: newRelativePath,
                  directory: fullPath,
                  fileCount: fileCount
                });
              } else {
                app.debug(`📁 Directory ${newRelativePath} has no parquet files`);
              }
              
              walkPaths(fullPath, newRelativePath);
            }
          });
        } catch (error) {
          app.debug(`❌ Error reading directory ${currentPath}: ${error.message}`);
        }
      }
      
      if (fs.existsSync(vesselsDir)) {
        walkPaths(vesselsDir);
      }
      
      app.debug(`📊 Path discovery complete: found ${paths.length} paths with data`);
      return paths;
    }

    // Get available SignalK paths
    router.get('/api/paths', (_, res) => {
      try {
        const dataDir = getDataDir();
        const paths = getAvailablePaths(dataDir);
        
        res.json({
          success: true,
          dataDirectory: dataDir,
          paths: paths
        });
      } catch (error) {
        res.status(500).json({
          success: false,
          error: error.message
        });
      }
    });

    // Get files for a specific path
    router.get('/api/files/:path(*)', (req, res) => {
      try {
        const dataDir = getDataDir();
        const signalkPath = req.params.path;
        const selfContextPath = app.selfContext.replace(/\./g, '/');
        const pathDir = path.join(dataDir, selfContextPath, signalkPath.replace(/\./g, '/'));
        
        if (!fs.existsSync(pathDir)) {
          return res.status(404).json({
            success: false,
            error: `Path not found: ${signalkPath}`
          });
        }
        
        const files = fs.readdirSync(pathDir)
          .filter(file => file.endsWith('.parquet'))
          .map(file => {
            const filePath = path.join(pathDir, file);
            const stat = fs.statSync(filePath);
            return {
              name: file,
              path: filePath,
              size: stat.size,
              modified: stat.mtime.toISOString()
            };
          })
          .sort((a, b) => new Date(b.modified) - new Date(a.modified));
        
        res.json({
          success: true,
          path: signalkPath,
          directory: pathDir,
          files: files
        });
      } catch (error) {
        res.status(500).json({
          success: false,
          error: error.message
        });
      }
    });

    // Get sample data from a specific file
    router.get('/api/sample/:path(*)', async (req, res) => {
      try {
        if (!DuckDBInstance) {
          return res.status(503).json({
            success: false,
            error: 'DuckDB not available'
          });
        }

        const dataDir = getDataDir();
        const signalkPath = req.params.path;
        const limit = parseInt(req.query.limit) || 10;
        
        const selfContextPath = app.selfContext.replace(/\./g, '/');
        const pathDir = path.join(dataDir, selfContextPath, signalkPath.replace(/\./g, '/'));
        
        if (!fs.existsSync(pathDir)) {
          return res.status(404).json({
            success: false,
            error: `Path not found: ${signalkPath}`
          });
        }
        
        // Get the most recent parquet file
        const files = fs.readdirSync(pathDir)
          .filter(file => file.endsWith('.parquet'))
          .map(file => {
            const filePath = path.join(pathDir, file);
            const stat = fs.statSync(filePath);
            return { name: file, path: filePath, modified: stat.mtime };
          })
          .sort((a, b) => b.modified - a.modified);
        
        if (files.length === 0) {
          return res.status(404).json({
            success: false,
            error: `No parquet files found for path: ${signalkPath}`
          });
        }
        
        const sampleFile = files[0];
        const query = `SELECT * FROM '${sampleFile.path}' LIMIT ${limit}`;
        
        const instance = await DuckDBInstance.create();
        const connection = await instance.connect();
        try {
          const reader = await connection.runAndReadAll(query);
          const rawData = reader.getRowObjects();
          
          // Convert BigInt values to regular numbers for JSON serialization
          const data = rawData.map(row => {
            const convertedRow = {};
            for (const [key, value] of Object.entries(row)) {
              convertedRow[key] = typeof value === 'bigint' ? Number(value) : value;
            }
            return convertedRow;
          });
          
          // Get column info
          const columns = data.length > 0 ? Object.keys(data[0]) : [];
          
          res.json({
            success: true,
            path: signalkPath,
            file: sampleFile.name,
            columns: columns,
            rowCount: data.length,
            data: data
          });
        } catch (err) {
          return res.status(400).json({
            success: false,
            error: err.message
          });
        } finally {
          connection.disconnectSync();
        }
        
      } catch (error) {
        res.status(500).json({
          success: false,
          error: error.message
        });
      }
    });

    // Query parquet data
    router.post('/api/query', async (req, res) => {
      try {
        if (!DuckDBInstance) {
          return res.status(503).json({
            success: false,
            error: 'DuckDB not available'
          });
        }

        const { query } = req.body;
        
        if (!query) {
          return res.status(400).json({
            success: false,
            error: 'Query is required'
          });
        }
        
        const dataDir = getDataDir();
        
        // Replace placeholder paths in query with actual file paths
        let processedQuery = query;
        
        // Find all quoted paths in the query that might be SignalK paths
        const pathMatches = query.match(/'([^']+)'/g);
        if (pathMatches) {
          pathMatches.forEach(match => {
            const quotedPath = match.slice(1, -1); // Remove quotes
            
            // If it looks like a SignalK path, convert to file path
            const selfContextPath = app.selfContext.replace(/\./g, '/');
            if (quotedPath.includes(`/${selfContextPath}/`) || quotedPath.includes('.parquet')) {
              // It's already a file path, use as is
              return;
            } else if (quotedPath.includes('.') && !quotedPath.includes('/')) {
              // It's a SignalK path, convert to file path
              const filePath = path.join(dataDir, selfContextPath, quotedPath.replace(/\./g, '/'), '*.parquet');
              processedQuery = processedQuery.replace(match, `'${filePath}'`);
            }
          });
        }
        
        console.log('Executing query:', processedQuery);
        
        const instance = await DuckDBInstance.create();
        const connection = await instance.connect();
        try {
          const reader = await connection.runAndReadAll(processedQuery);
          const rawData = reader.getRowObjects();
          
          // Convert BigInt values to regular numbers for JSON serialization
          const data = rawData.map(row => {
            const convertedRow = {};
            for (const [key, value] of Object.entries(row)) {
              convertedRow[key] = typeof value === 'bigint' ? Number(value) : value;
            }
            return convertedRow;
          });
          
          res.json({
            success: true,
            query: processedQuery,
            rowCount: data.length,
            data: data
          });
        } catch (err) {
          console.error('Query error:', err);
          return res.status(400).json({
            success: false,
            error: err.message
          });
        } finally {
          connection.disconnectSync();
        }
        
      } catch (error) {
        res.status(500).json({
          success: false,
          error: error.message
        });
      }
    });

    // Test S3 connection
    router.post('/api/test-s3', async (_, res) => {
      try {
        if (!currentConfig) {
          return res.status(500).json({
            success: false,
            error: 'Plugin not started or configuration not available'
          });
        }
        
        if (!currentConfig.s3Upload.enabled) {
          return res.status(400).json({
            success: false,
            error: 'S3 upload is not enabled in configuration'
          });
        }

        if (!S3Client || !s3Client) {
          return res.status(503).json({
            success: false,
            error: 'S3 client not available or not initialized'
          });
        }

        // Test S3 connection by listing bucket
        const { ListObjectsV2Command } = require('@aws-sdk/client-s3');
        const listCommand = new ListObjectsV2Command({
          Bucket: currentConfig.s3Upload.bucket,
          MaxKeys: 1
        });

        await s3Client.send(listCommand);
        
        res.json({
          success: true,
          message: 'S3 connection successful',
          bucket: currentConfig.s3Upload.bucket,
          region: currentConfig.s3Upload.region || 'us-east-1',
          keyPrefix: currentConfig.s3Upload.keyPrefix || 'none'
        });
      } catch (error) {
        app.debug('S3 test connection error:', error);
        res.status(500).json({
          success: false,
          error: error.message || 'S3 connection failed'
        });
      }
    });

    // Health check
    router.get('/api/health', (_, res) => {
      res.json({
        success: true,
        status: 'healthy',
        timestamp: new Date().toISOString(),
        duckdb: DuckDBInstance ? 'available' : 'not available'
      });
    });

    app.debug('Webapp API routes registered');
  };

  return plugin;
};