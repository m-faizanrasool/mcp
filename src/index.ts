import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import mysql from "mysql2/promise";
import fs from "fs";
import path from "path";

// Configure logging
const logDir = path.resolve("./logs");
if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir);
}

const logStream = fs.createWriteStream(path.join(logDir, "mcp_server.log"), { flags: "a" });

function log(level: string, message: string, error?: any) {
    const timestamp = new Date().toISOString();
    const logMessage = `${timestamp} - ${level} - ${message}${error ? "\n" + error.stack : ""}`;
    console.log(logMessage);
    logStream.write(logMessage + "\n");
}

// Define the connection state
type AppContext = {
    connection: mysql.Connection | null;
    config: {
        host: string;
        database: string;
        user: string;
        password: string;
    };
};

// Global state
let dbConnection: mysql.Connection | null = null;

// Create an MCP server with a name
const server = new McpServer({
    name: "Remixer MCP",
    version: "1.0.0",
});

// Initialize database connection
async function initializeDatabase(): Promise<AppContext> {
    const config = {
        host: "localhost",
        database: "theportal_test",
        user: "root",
        password: "",
    };

    try {
        log("INFO", "Connecting to MySQL Database: " + config.database);
        const connection = await mysql.createConnection({
            host: config.host,
            database: config.database,
            user: config.user,
            password: config.password,
        });

        dbConnection = connection;
        log("INFO", "Connected to MySQL Database: " + config.database);

        // Handle process termination
        process.on("exit", () => closeConnection());
        process.on("SIGINT", () => {
            closeConnection();
            process.exit(0);
        });

        return { connection, config };
    } catch (err: any) {
        log("ERROR", "Error connecting to MySQL: " + err.message, err);
        return { connection: null, config };
    }
}

async function closeConnection() {
    if (dbConnection) {
        try {
            await dbConnection.end();
            log("INFO", "MySQL connection closed");
            dbConnection = null;
        } catch (err: any) {
            log("ERROR", "Error closing MySQL connection: " + err.message, err);
        }
    }
}

// Resource to list available tables
server.resource(
    "tables",
    "schema://tables",
    async (uri) => {
        if (!dbConnection) {
            return {
                contents: [{
                    uri: uri.href,
                    text: "Database connection is not available"
                }]
            };
        }

        try {
            const [rows] = await dbConnection.query('SHOW TABLES');
            const tables = rows as any[];

            let result = "Available tables:\n";
            for (const table of tables) {
                const tableName = Object.values(table)[0];
                result += `- ${tableName}\n`;
            }

            return {
                contents: [{
                    uri: uri.href,
                    text: result
                }]
            };
        } catch (err: any) {
            log("ERROR", "Error listing tables: " + err.message, err);
            return {
                contents: [{
                    uri: uri.href,
                    text: "Error listing tables: " + err.message
                }]
            };
        }
    }
);

// Resource to get a table schema
server.resource(
    "table-schema",
    new ResourceTemplate("schema://tables/{table_name}", { list: undefined }),
    async (uri, { table_name }) => {
        if (!dbConnection) {
            return {
                contents: [{
                    uri: uri.href,
                    text: "Database connection is not available"
                }]
            };
        }

        try {
            const [columns] = await dbConnection.query(`DESCRIBE ${table_name}`);
            const columnData = columns as any[];

            let result = `Schema for table '${table_name}':\n`;
            for (const column of columnData) {
                result += `- ${column.Field} (${column.Type})`;
                if (column.Key === "PRI") {
                    result += " PRIMARY KEY";
                }
                if (column.Null === "NO") {
                    result += " NOT NULL";
                }
                result += "\n";
            }

            return {
                contents: [{
                    uri: uri.href,
                    text: result
                }]
            };
        } catch (err: any) {
            log("ERROR", `Error getting schema for table ${table_name}: ${err.message}`, err);
            return {
                contents: [{
                    uri: uri.href,
                    text: `Error getting schema for table ${table_name}: ${err.message}`
                }]
            };
        }
    }
);

// Tool to run read-only SQL queries
server.tool(
    "run_query",
    { query: z.string() },
    async ({ query }) => {
        if (!dbConnection) {
            return {
                content: [{ type: "text", text: "Database connection is not available" }]
            };
        }

        // Safety check for read-only queries
        const queryLower = query.toLowerCase().trim();
        if (!queryLower.startsWith("select") && !queryLower.startsWith("show")) {
            return {
                content: [{ type: "text", text: "Only SELECT and SHOW queries are allowed for safety reasons" }]
            };
        }

        try {
            const [results] = await dbConnection.query(query);
            const rows = results as any[];

            if (!rows || rows.length === 0) {
                return {
                    content: [{ type: "text", text: "Query executed successfully but returned no results" }]
                };
            }

            // Format results as a table
            const headers = Object.keys(rows[0]);
            const headerRow = headers.join(" | ");
            const separator = "-".repeat(headerRow.length);

            let output = `${headerRow}\n${separator}\n`;
            for (const row of rows) {
                output += Object.values(row).map(value => String(value)).join(" | ") + "\n";
            }

            return {
                content: [{ type: "text", text: output }]
            };
        } catch (err: any) {
            log("ERROR", `Error executing query: ${err.message}`, err);
            return {
                content: [{ type: "text", text: `Error executing query: ${err.message}` }],
                isError: true
            };
        }
    }
);

// Tool to move a document
server.tool(
    "move_document",
    {
        document_id: z.string(),
        target_folder_id: z.string()
    },
    async ({ document_id, target_folder_id }) => {
        if (!dbConnection) {
            return {
                content: [{ type: "text", text: "Database connection is not available" }]
            };
        }

        try {
            const [result] = await dbConnection.query(
                "UPDATE user_openai SET folder_id = ? WHERE id = ?",
                [target_folder_id, document_id]
            );

            const updateResult = result as any;
            const affectedRows = updateResult.affectedRows;

            if (affectedRows > 0) {
                return {
                    content: [{ type: "text", text: `Successfully moved document ${document_id} to folder ${target_folder_id}` }]
                };
            } else {
                return {
                    content: [{ type: "text", text: `Document ${document_id} not found or already in folder ${target_folder_id}` }]
                };
            }
        } catch (err: any) {
            log("ERROR", `Error moving document: ${err.message}`, err);
            return {
                content: [{ type: "text", text: `Error moving document: ${err.message}` }],
                isError: true
            };
        }
    }
);

// Prompt for data analysis
server.prompt(
    "analyze_table_data",
    {},
    () => ({
        messages: [{
            role: "user",
            content: {
                type: "text",
                text: `
                    I want to analyze data in a table. Please follow these steps:

                    1. First, show me the available tables
                    2. I'll select a table, and you'll show me its schema
                    3. Help me create a SQL query to analyze the data
                    4. Run the query and explain the results

                    Let's start by listing the tables.
                    `
            }
        }]
    })
);

// Prompt for moving documents
server.prompt(
    "move_document_prompt",
    {},
    () => ({
        messages: [{
            role: "user",
            content: {
                type: "text",
                text: `
                    I want to move a document to a different folder. Please help me by:

                    1. First, confirm the document ID I want to move
                    2. Then, confirm the target folder ID
                    3. Execute the move operation
                    4. Confirm the operation was successful

                    Let's get started.
                    `
            }
        }]
    })
);

// Main function
async function main() {
    try {
        log("INFO", "Starting MCP server...");

        // Initialize the database
        await initializeDatabase();

        // Start the server with stdio transport
        const transport = new StdioServerTransport();

        // This is the key fix - we need to properly handle the connection
        await server.connect(transport);

        log("INFO", "Server connected successfully");
    } catch (err: any) {
        log("CRITICAL", "Server crashed with error: " + err.message, err);
        process.exit(1);
    }
}

main();