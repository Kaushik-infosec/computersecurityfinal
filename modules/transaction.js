const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../config/db'); // Assuming this returns a MySQL connection

// Constants for table names
const TRANSACTIONS_TABLE = 'transactions';
const USERS_TABLE = 'users';

// Create a new transaction
const createTransaction = async (fromUsername, toUsername, amount, type) => {
    const db = await getDb();
    const transactionId = uuidv4();
    const query = `
        INSERT INTO ${TRANSACTIONS_TABLE} (transactionId, fromUsername, toUsername, amount, type, version, timestamp)
        VALUES (?, ?, ?, ?, ?, 0, NOW());
    `;
    const params = [transactionId, fromUsername, toUsername, amount, type];
    await db.execute(query, params);
    return transactionId;
};

// Get a transaction by ID
const getTransactionById = async (transactionId) => {
    const db = await getDb();
    const query = `SELECT * FROM ${TRANSACTIONS_TABLE} WHERE transactionId = ?`;
    const [rows] = await db.execute(query, [transactionId]);
    return rows[0];
};

// Update the transaction status (approve/reject) with optimistic locking
const updateTransactionStatus = async (transactionId, newStatus) => {
    const db = await getDb();
    const selectQuery = `SELECT version FROM ${TRANSACTIONS_TABLE} WHERE transactionId = ?`;
    const [rows] = await db.execute(selectQuery, [transactionId]);

    if (rows.length === 0) {
        throw new Error('Transaction not found.');
    }

    const { version } = rows[0];
    const updateQuery = `
        UPDATE ${TRANSACTIONS_TABLE}
        SET status = ?, version = version + 1
        WHERE transactionId = ? AND version = ?;
    `;
    const [result] = await db.execute(updateQuery, [newStatus, transactionId, version]);

    if (result.affectedRows === 0) {
        throw new Error('Concurrent modification detected. Please try again.');
    }

    return true;
};

// Get all pending requests for a user
const getPendingRequestsForUser = async (username) => {
    const db = await getDb();
    const query = `
        SELECT * FROM ${TRANSACTIONS_TABLE}
        WHERE fromUsername = ? AND status = 'pending';
    `;
    const [rows] = await db.execute(query, [username]);
    return rows;
};

// Update user balance with optimistic locking
const updateBalance = async (username, amount) => {
    const db = await getDb();
    const selectQuery = `SELECT balance, version FROM ${USERS_TABLE} WHERE username = ?`;
    const [rows] = await db.execute(selectQuery, [username]);

    if (rows.length === 0) {
        throw new Error('User not found.');
    }

    const { balance, version } = rows[0];
    const updateQuery = `
        UPDATE ${USERS_TABLE}
        SET balance = balance + ?, version = version + 1
        WHERE username = ? AND version = ?;
    `;
    const [result] = await db.execute(updateQuery, [amount, username, version]);

    if (result.affectedRows === 0) {
        throw new Error('Concurrent modification detected. Please try again.');
    }

    return true;
};

// Send money from one user to another
const sendMoney = async (username, toUsername, amount) => {
    const senderBalance = await getBalance(username);

    if (senderBalance < amount) {
        return `Insufficient funds. Your balance is $${senderBalance}.`;
    }

    await updateBalance(username, -amount);
    await updateBalance(toUsername, amount);
    const transactionId = await createTransaction(username, toUsername, amount, 'send');
    return `Transaction successful. Transaction ID: ${transactionId}`;
};

// Request money from another user
const requestMoney = async (username, toUsername, amount) => {
    if (amount <= 0) {
        return `Invalid amount. Please enter a positive number.`;
    }

    const transactionId = await createTransaction(username, toUsername, amount, 'request');
    return `Money request sent successfully. Transaction ID: ${transactionId}`;
};

// View pending requests for a user
const viewRequests = async (username) => {
    const requests = await getPendingRequestsForUser(username);

    if (requests.length === 0) {
        return `No pending requests.`;
    }

    return requests;
};

// Approve or reject a money request
const approveRequest = async (username, transactionId, approval) => {
    const request = await getTransactionById(transactionId);

    if (!request || request.toUsername !== username) {
        return `Request not found or you don't have permission to approve it.`;
    }

    if (approval === 'approve') {
        const balance = await getBalance(username);

        if (balance < request.amount) {
            return `Insufficient balance to approve this request.`;
        }

        await updateBalance(username, -request.amount);
        await updateBalance(request.fromUsername, request.amount);
        await updateTransactionStatus(transactionId, 'approved');

        return `Request approved. Transaction ID: ${transactionId}, Amount: $${request.amount}.`;
    } else if (approval === 'reject') {
        await updateTransactionStatus(transactionId, 'rejected');
        return `Request rejected. Transaction ID: ${transactionId}`;
    } else {
        return `Invalid approval option. Use "approve" or "reject".`;
    }
};

// Cancel a request
const cancelRequest = async (username, transactionId, approval) => {
    const request = await getTransactionById(transactionId);

    if (!request || request.fromUsername !== username) {
        return `Request not found or you don't have permission to cancel it.`;
    }

    if (approval === 'reject') {
        await updateTransactionStatus(transactionId, 'rejected');
        return `Request rejected. Transaction ID: ${transactionId}`;
    }
};

// Get a user's balance
const getBalance = async (username) => {
    const db = await getDb();
    const query = `SELECT balance FROM ${USERS_TABLE} WHERE username = ?`;
    const [rows] = await db.execute(query, [username]);
    return rows.length > 0 ? rows[0].balance : 0;
};

// View requests by transaction ID
const viewRequestsByTXID = async (transactionId) => {
    const db = await getDb();
    const query = `SELECT * FROM ${TRANSACTIONS_TABLE} WHERE transactionId = ?`;
    const [rows] = await db.execute(query, [transactionId]);
    return rows.length > 0 ? rows[0] : null;
};

module.exports = {
    createTransaction,
    getTransactionById,
    updateTransactionStatus,
    getPendingRequestsForUser,
    sendMoney,
    requestMoney,
    viewRequests,
    approveRequest,
    cancelRequest,
    updateBalance,
    viewRequestsByTXID,
};
