const fs = require('fs-extra');
const path = require('path');

// Try to import ParquetJS, fall back if not available
let parquet;
try {
  parquet = require('@dsnp/parquetjs');
} catch (error) {
  console.warn('ParquetJS not available, will use JSON fallback');
  parquet = null;
}

// For now, we'll use a simple CSV/JSON approach until parquet-wasm is properly integrated
// This maintains compatibility with your existing data analysis tools

class ParquetWriter {
  constructor(options = {}) {
    this.format = options.format || 'json'; // 'json', 'csv', or 'parquet'
  }

  async writeRecords(filepath, records) {
    try {
      await fs.ensureDir(path.dirname(filepath));
      
      switch (this.format) {
        case 'json':
          await this.writeJSON(filepath, records);
          break;
        case 'csv':
          await this.writeCSV(filepath, records);
          break;
        case 'parquet':
          await this.writeParquet(filepath, records);
          break;
        default:
          throw new Error(`Unsupported format: ${this.format}`);
      }
      
      return filepath;
    } catch (error) {
      throw new Error(`Failed to write records: ${error.message}`);
    }
  }

  async writeJSON(filepath, records) {
    const jsonPath = filepath.replace(/\.(parquet|csv)$/, '.json');
    await fs.writeJson(jsonPath, records, { spaces: 2 });
    return jsonPath;
  }

  async writeCSV(filepath, records) {
    if (records.length === 0) return;
    
    const csvPath = filepath.replace(/\.(parquet|json)$/, '.csv');
    
    // Get all unique keys from all records
    const allKeys = new Set();
    records.forEach(record => {
      Object.keys(record).forEach(key => allKeys.add(key));
    });
    
    const headers = Array.from(allKeys).sort();
    const csvRows = [headers.join(',')];
    
    records.forEach(record => {
      const row = headers.map(header => {
        const value = record[header];
        if (value === null || value === undefined) return '';
        if (typeof value === 'string' && (value.includes(',') || value.includes('"'))) {
          return `"${value.replace(/"/g, '""')}"`;
        }
        return String(value);
      });
      csvRows.push(row.join(','));
    });
    
    await fs.writeFile(csvPath, csvRows.join('\n'));
    return csvPath;
  }

  async writeParquet(filepath, records) {
    try {
      if (records.length === 0) {
        console.warn('No records to write to Parquet file');
        return filepath;
      }

      // Check if ParquetJS is available
      if (!parquet) {
        console.warn('ParquetJS not available, falling back to JSON');
        return this.writeJSON(filepath, records);
      }

      console.log(`Attempting to write ${records.length} records to Parquet`);
      console.log('Sample record keys:', Object.keys(records[0]));
      console.log('Sample record:', JSON.stringify(records[0], null, 2));

      // Define schema based on SignalK data structure
      const schemaFields = {
        received_timestamp: { type: 'UTF8', optional: true },
        signalk_timestamp: { type: 'UTF8', optional: true },
        context: { type: 'UTF8', optional: true },
        path: { type: 'UTF8', optional: true },
        value: { type: 'UTF8', optional: true },  // Store as string for flexibility
        value_json: { type: 'UTF8', optional: true },
        source: { type: 'UTF8', optional: true },
        source_label: { type: 'UTF8', optional: true },
        source_type: { type: 'UTF8', optional: true },
        source_pgn: { type: 'UTF8', optional: true },
        source_src: { type: 'UTF8', optional: true },
        meta: { type: 'UTF8', optional: true }
      };

      // Add any additional fields from the actual data
      const allKeys = new Set();
      records.forEach(record => {
        Object.keys(record).forEach(key => allKeys.add(key));
      });

      allKeys.forEach(key => {
        if (!schemaFields[key]) {
          schemaFields[key] = { type: 'UTF8', optional: true };
        }
      });

      const schema = new parquet.ParquetSchema(schemaFields);
      console.log(`Creating Parquet schema with ${Object.keys(schemaFields).length} fields:`, Object.keys(schemaFields));
      
      // Create Parquet writer
      const writer = await parquet.ParquetWriter.openFile(schema, filepath);
      console.log('Parquet writer created successfully');
      
      // Write records to Parquet file
      for (let i = 0; i < records.length; i++) {
        const record = records[i];
        const cleanRecord = {};
        
        // Ensure all schema fields are present and properly formatted
        Object.keys(schemaFields).forEach(fieldName => {
          const value = record[fieldName];
          if (value === null || value === undefined) {
            cleanRecord[fieldName] = null;
          } else if (typeof value === 'object') {
            cleanRecord[fieldName] = JSON.stringify(value);
          } else {
            cleanRecord[fieldName] = String(value);
          }
        });
        
        console.log(`Writing record ${i + 1}/${records.length}`);
        await writer.appendRow(cleanRecord);
      }
      
      // Close the writer
      console.log('Closing Parquet writer...');
      await writer.close();
      
      console.log(`✅ Successfully wrote ${records.length} records to Parquet: ${filepath}`);
      return filepath;
      
    } catch (error) {
      console.error('❌ Parquet writing failed:', error.message);
      console.error('Error stack:', error.stack);
      
      // Save to failed directory to maintain schema consistency
      const failedDir = path.join(path.dirname(filepath), 'failed');
      await fs.ensureDir(failedDir);
      const failedPath = path.join(failedDir, path.basename(filepath).replace('.parquet', '_FAILED.json'));
      
      console.error(`💾 Saving failed Parquet data as JSON to: ${failedPath}`);
      console.error('⚠️  This data will need manual conversion to maintain DuckDB schema consistency');
      
      await this.writeJSON(failedPath, records);
      
      // Throw error to alert system that Parquet writing is broken
      throw new Error(`Parquet writing failed for ${filepath}. Data saved to ${failedPath} for recovery.`);
    }
  }

  // Create Parquet schema based on sample records
  createParquetSchema(records) {
    if (!parquet || records.length === 0) {
      throw new Error('Cannot create Parquet schema');
    }

    // Get all unique column names from all records
    const allColumns = new Set();
    records.forEach(record => {
      Object.keys(record).forEach(key => allColumns.add(key));
    });

    const columns = Array.from(allColumns).sort();
    const schemaFields = {};

    // Analyze each column to determine the best Parquet type
    columns.forEach(colName => {
      const values = records.map(r => r[colName]).filter(v => v !== null && v !== undefined);
      
      if (values.length === 0) {
        // All null values, default to string
        schemaFields[colName] = { type: 'UTF8', optional: true };
        return;
      }

      const hasNumbers = values.some(v => typeof v === 'number');
      const hasStrings = values.some(v => typeof v === 'string');
      const hasBooleans = values.some(v => typeof v === 'boolean');
      
      if (hasNumbers && !hasStrings && !hasBooleans) {
        // All numbers - check if integers or floats
        const allIntegers = values.every(v => Number.isInteger(v));
        schemaFields[colName] = { 
          type: allIntegers ? 'INT64' : 'DOUBLE', 
          optional: true 
        };
      } else if (hasBooleans && !hasNumbers && !hasStrings) {
        schemaFields[colName] = { type: 'BOOLEAN', optional: true };
      } else {
        // Mixed types or strings - use UTF8
        schemaFields[colName] = { type: 'UTF8', optional: true };
      }
    });

    return new parquet.ParquetSchema(schemaFields);
  }

  // Prepare a record for Parquet writing (type conversion)
  prepareRecordForParquet(record) {
    const prepared = {};
    
    // Get all fields from the record (ParquetJS schema handling)
    for (const [fieldName, value] of Object.entries(record)) {
      if (value === null || value === undefined) {
        prepared[fieldName] = null;
      } else if (typeof value === 'object') {
        // Convert complex objects to JSON strings
        prepared[fieldName] = JSON.stringify(value);
      } else {
        prepared[fieldName] = value;
      }
    }

    return prepared;
  }

  // Merge multiple files (for daily consolidation like Python version)
  async mergeFiles(sourceFiles, targetFile) {
    try {
      const allRecords = [];
      
      for (const sourceFile of sourceFiles) {
        if (await fs.pathExists(sourceFile)) {
          const ext = path.extname(sourceFile).toLowerCase();
          
          if (ext === '.json') {
            const records = await fs.readJson(sourceFile);
            allRecords.push(...(Array.isArray(records) ? records : [records]));
          } else if (ext === '.parquet') {
            // Read Parquet file
            if (parquet) {
              try {
                const reader = await parquet.ParquetReader.openFile(sourceFile);
                const cursor = reader.getCursor();
                let record = null;
                while (record = await cursor.next()) {
                  allRecords.push(record);
                }
                await reader.close();
              } catch (parquetError) {
                console.warn(`Failed to read Parquet file ${sourceFile}:`, parquetError.message);
              }
            }
          } else if (ext === '.csv') {
            // Could implement CSV reading if needed
            console.warn(`CSV merging not implemented for ${sourceFile}`);
          }
        }
      }
      
      if (allRecords.length > 0) {
        // Sort by timestamp
        allRecords.sort((a, b) => {
          const timeA = a.received_timestamp || a.signalk_timestamp || '';
          const timeB = b.received_timestamp || b.signalk_timestamp || '';
          return timeA.localeCompare(timeB);
        });
        
        await this.writeRecords(targetFile, allRecords);
        return allRecords.length;
      }
      
      return 0;
    } catch (error) {
      throw new Error(`Failed to merge files: ${error.message}`);
    }
  }

  // Daily file consolidation (matching Python behavior)
  async consolidateDaily(dataDir, date, filenamePrefix = 'signalk_data') {
    try {
      const dateStr = date.toISOString().split('T')[0]; // YYYY-MM-DD
      const consolidatedFiles = [];
      
      // Walk through all topic directories
      const walkDir = async (dir) => {
        const items = await fs.readdir(dir);
        
        for (const item of items) {
          const itemPath = path.join(dir, item);
          const stat = await fs.stat(itemPath);
          
          if (stat.isDirectory()) {
            await walkDir(itemPath);
          } else if (item.includes(dateStr) && !item.includes('_consolidated')) {
            // This is a file for our target date
            const topicDir = path.dirname(itemPath);
            const consolidatedFile = path.join(topicDir, `${filenamePrefix}_${dateStr}_consolidated.parquet`);
            
            if (!consolidatedFiles.find(f => f.target === consolidatedFile)) {
              consolidatedFiles.push({
                target: consolidatedFile,
                sources: []
              });
            }
            
            const entry = consolidatedFiles.find(f => f.target === consolidatedFile);
            entry.sources.push(itemPath);
          }
        }
      };
      
      await walkDir(dataDir);
      
      // Consolidate each topic's files
      for (const entry of consolidatedFiles) {
        const recordCount = await this.mergeFiles(entry.sources, entry.target);
        console.log(`Consolidated ${entry.sources.length} files into ${entry.target} (${recordCount} records)`);
        
        // Move source files to processed folder
        const processedDir = path.join(path.dirname(entry.target), 'processed');
        await fs.ensureDir(processedDir);
        
        for (const sourceFile of entry.sources) {
          const basename = path.basename(sourceFile);
          const processedFile = path.join(processedDir, basename);
          await fs.move(sourceFile, processedFile);
        }
      }
      
      return consolidatedFiles.length;
    } catch (error) {
      throw new Error(`Failed to consolidate daily files: ${error.message}`);
    }
  }
}

module.exports = ParquetWriter;