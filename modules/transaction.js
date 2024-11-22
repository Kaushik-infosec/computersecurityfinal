const { v4: uuidv4 } = require('uuid');
const mysql = require('mysql2/promise');
require('dotenv').config();

// Database connection pool
const pool = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
});

// Helper function for executing queries
const query = async (sql, params = []) => {
    try {
        const [results] = await pool.execute(sql, params);
        return results;
    } catch (err) {
        console.error('Database query error:', err);
        throw err;
    }
};

// Constants for table names
const TRANSACTIONS_TABLE = 'transactions';
const USERS_TABLE = 'users';

// Fetch a user by username
const getUser = async (username) => {
    try {
        const rows = await query(`SELECT * FROM ${USERS_TABLE} WHERE username = ?`, [username]);
        return rows[0] || null;
    } catch (err) {
        console.error('Error fetching user:', err);
        throw err;
    }
};

// Create a new transaction
const createTransaction = async (fromUsername, toUsername, amount, type) => {
    try {
        const transactionId = uuidv4();
        const sql = `
            INSERT INTO ${TRANSACTIONS_TABLE} (transactionId, fromUsername, toUsername, amount, type, version, timestamp)
            VALUES (?, ?, ?, ?, ?, 0, NOW())
        `;
        await query(sql, [transactionId, fromUsername, toUsername, amount, type]);
        return transactionId;
    } catch (err) {
        console.error('Error creating transaction:', err);
        throw err;
    }
};

// Get a transaction by ID
const getTransactionById = async (transactionId) => {
    try {
        const rows = await query(`SELECT * FROM ${TRANSACTIONS_TABLE} WHERE transactionId = ?`, [transactionId]);
        return rows[0] || null;
    } catch (err) {
        console.error('Error fetching transaction:', err);
        throw err;
    }
};

// Update the transaction status with optimistic locking
const updateTransactionStatus = async (transactionId, newStatus) => {
    try {
        const selectQuery = `SELECT version FROM ${TRANSACTIONS_TABLE} WHERE transactionId = ?`;
        const rows = await query(selectQuery, [transactionId]);

        if (!rows.length) {
            return('Transaction not found.');
        }

        const { version } = rows[0];
        const updateQuery = `
            UPDATE ${TRANSACTIONS_TABLE}
            SET status = ?, version = version + 1
            WHERE transactionId = ? AND version = ?
        `;
        const result = await query(updateQuery, [newStatus, transactionId, version]);

        if (result.affectedRows === 0) {
            return('Concurrent modification detected. Please try again.');
        }

        return true;
    } catch (err) {
        console.error('Error updating transaction status:', err);
        throw err;
    }
};

// Get all pending requests for a user
const getPendingRequestsForUser = async (username) => {
    try {
        const sql = `
            SELECT * FROM ${TRANSACTIONS_TABLE}
            WHERE fromUsername = ? AND status = 'pending'
        `;
        return await query(sql, [username]);
    } catch (err) {
        console.error('Error fetching pending requests:', err);
        throw err;
    }
};

// Update user balance with optimistic locking
const updateBalance = async (username, amount) => {
    try {
        const connection = await pool.getConnection();
        try {
            await connection.beginTransaction();

            const selectQuery = `SELECT balance, version FROM ${USERS_TABLE} WHERE username = ? FOR UPDATE`;
            const [rows] = await connection.execute(selectQuery, [username]);

            if (!rows.length) {
                return('User not found.');
            }

            const { version } = rows[0];

            // Update balance only if it doesn't go below zero
            const updateQuery = `
                UPDATE ${USERS_TABLE}
                SET balance = balance + ?, version = version + 1
                WHERE username = ? AND version = ? AND (balance + ?) >= 0
            `;
            const [result] = await connection.execute(updateQuery, [amount, username, version, amount]);

            if (result.affectedRows === 0) {
                return('Insufficient balance or concurrent modification detected.');
            }
            

            await connection.commit();
            return 'Balance updated successfully.';
        } catch (err) {
            await connection.rollback();
            console.error('Error updating balance:', err);
            throw err;
        } finally {
            connection.release();
        }
    } catch (err) {
        console.error('Error in updateBalance:', err);
        throw err;
    }
};



// Send money between users
const sendMoney = async (username, toUsername, amount) => {
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();

        const senderBalanceQuery = `SELECT balance FROM ${USERS_TABLE} WHERE username = ?`;
        const [senderRows] = await connection.execute(senderBalanceQuery, [username]);

        if (!senderRows.length || senderRows[0].balance < amount) {
            return('Insufficient funds or sender not found.');
        }

        await updateBalance(username, -amount);
        await updateBalance(toUsername, amount);
        const transactionId = await createTransaction(username, toUsername, amount, 'send');

        await connection.commit();
        return `Transaction successful. Transaction ID: ${transactionId}`;
    } catch (err) {
        await connection.rollback();
        console.error('Error during send money:', err);
        throw err;
    } finally {
        connection.release();
    }
};

// Request money from another user
const requestMoney = async (toUsername, Username, amount) => {
    try {
        if (amount <= 0) {
            return('Amount must be positive.');
        }

        const userExists = await getUser(toUsername);
        if (!userExists) {
            return(`Recipient "${toUsername}" does not exist.`);
        }

        const transactionId = await createTransaction(toUsername, Username, amount, 'request');
        return `Request sent. Transaction ID: ${transactionId}`;
    } catch (err) {
        console.error('Error requesting money:', err);
        throw err;
    }
};


// Function to view requests for a user
const viewRequests = async (username) => {
    try {
        const sql = `
        SELECT * FROM ${TRANSACTIONS_TABLE}
        WHERE fromUsername = ? AND type = 'request' AND status = 'pending'
        ORDER BY timestamp DESC;
        `;
        return await query(sql, [username]);
    } catch (err) {
        console.error('Error viewing requests:', err);
        throw err;
    }
};

// Function to view request details by transaction ID
const viewRequestsByTXID = async (transactionId) => {
    try {
        const sql = `SELECT * FROM ${TRANSACTIONS_TABLE} WHERE transactionId = ?`;
        const rows = await query(sql, [transactionId]);
        if (rows){
            return rows;
        } 
        
        // return('Transaction not found.');
        return 'Transaction not found.';
    } catch (err) {
        console.error('Error fetching request by TXID:', err);
        throw err;
    }
};

// Function to approve a money request
const approveRequest = async (username, transactionId) => {
    const connection = await pool.getConnection();
    try {
        console.log('Transaction ID:', transactionId); // Log the transaction ID

        await connection.beginTransaction();

        const selectQuery = `
        SELECT * FROM ${TRANSACTIONS_TABLE}
        WHERE transactionId = ? AND type = 'request' AND status = 'pending' AND fromUsername = ?
    `;
    const [rows] = await connection.execute(selectQuery, [transactionId, username]);
    
        console.log('Query Result:', rows); // Log the query result

        // Safely check if rows is an array and not empty
        if (!rows) {
            return(`Pending request not found for transactionId: ${transactionId}`);
        }

        console.log(rows);
        const { fromUsername, toUsername, amount } = rows[0];
        console.log(amount);
        // Ensure both users exist and sender has sufficient balance
        const senderBalanceQuery = `SELECT balance FROM ${USERS_TABLE} WHERE username = ?`;
        const [senderRows] = await connection.execute(senderBalanceQuery, [toUsername]);
        console.log('Sender Balance Query Result:', senderRows[0].balance); // Log the sender balance query result


        if (Number(senderRows[0].balance) < Number(amount)) {
            return 'Insufficient funds or sender not found.';
        }
        // Update balances
        await updateBalance(fromUsername, -amount);
        await updateBalance(toUsername, amount);

        // Mark request as approved
        const updateQuery = `
            UPDATE ${TRANSACTIONS_TABLE}
            SET status = 'approved', timestamp = NOW()
            WHERE transactionId = ?
        `;
        await connection.execute(updateQuery, [transactionId]);

        await connection.commit();
        return `Request approved successfully. ${transactionId}`;
    } catch (err) {
        await connection.rollback();
        console.error('Error approving request:', err);
        throw err;
    } finally {
        connection.release();
    }
};


// Function to cancel a request
const cancelRequest = async (username, transactionId) => {
    try {
        const sql = `
        UPDATE ${TRANSACTIONS_TABLE}
        SET status = 'rejected'
        WHERE transactionId = ? AND type = 'request' AND status = 'pending' AND fromUsername = ?;`;

        const result = await query(sql, [transactionId, username]);
        if (result.affectedRows === 0) return('Request not found or already processed.');

        return 'Request canceled successfully.';
    } catch (err) {
        console.error('Error canceling request:', err);
        throw err;
    }
};


module.exports = {
    getUser,
    createTransaction,
    getTransactionById,
    updateTransactionStatus,
    updateBalance,
    sendMoney,
    requestMoney,
    getPendingRequestsForUser,
    viewRequests,
    approveRequest,
    cancelRequest,
    viewRequestsByTXID,
};
