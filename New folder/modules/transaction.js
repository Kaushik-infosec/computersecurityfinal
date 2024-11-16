// transactions.js

const { v4: uuidv4, version } = require('uuid');
const { getDb } = require('../config/db');

const TRANSACTIONS_COLLECTION = 'transactions';
const USERS_COLLECTION = 'users'; // Assuming you have a 'users' collection to track balances

// Transaction Schema (model)
const transactionSchema = {
    transactionId: { type: String, required: true, unique: true },
    fromUsername: { type: String, required: true },
    toUsername: { type: String, required: true },
    amount: { type: Number, required: true },
    status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
    type: { type: String, enum: ['send', 'request'], required: true }, // 'send' or 'request'
    timestamp: { type: Date, default: Date.now },
    version: { type: Number, required: true},
};

// Create a new transaction
const createTransaction = async (fromUsername, toUsername, amount, type) => {
    const db = getDb();
    const transactionId = uuidv4(); // Generate unique transaction ID
    const transaction = {
        transactionId,
        fromUsername,
        toUsername,
        amount,
        type,
        version: 0
    };
    await db.collection(TRANSACTIONS_COLLECTION).insertOne(transaction);
    return transactionId;
};

// Get a transaction by ID
const getTransactionById = async (transactionId) => {
    const db = getDb();
    return await db.collection(TRANSACTIONS_COLLECTION).findOne({ transactionId });
};

// Update the transaction status (approve/reject)
const updateTransactionStatus = async (transactionId, newStatus) => {
    const db = getDb();

    // Retrieve the transaction and its version
    const transaction = await db.collection(TRANSACTIONS_COLLECTION).findOne({ transactionId });

    if (!transaction) {
        throw new Error('Transaction not found.');
    }

    const { version } = transaction;

    // Attempt to update the transaction status using optimistic locking
    const updateResult = await db.collection(TRANSACTIONS_COLLECTION).updateOne(
        { transactionId, version },  // Ensure version hasn't changed
        { $set: { type: newStatus, version: version + 1 } }  // Increment version
    );

    if (updateResult.modifiedCount === 0) {
        throw new Error('Concurrent modification detected. Please try again.');
    }

    return true;  // Indicate successful update
};


// Get all pending requests for a user
const getPendingRequestsForUser = async (username) => {
    try {
        const db = getDb();
        const pendingTransactions = await db.collection(TRANSACTIONS_COLLECTION)
            .find({
                fromUsername: username,
                type: 'pending'
            })
            .toArray();
        
        console.log("Fetched pending transactions:", pendingTransactions);
        // Ensure we're returning an array
        return Array.isArray(pendingTransactions) ? pendingTransactions : [];
    } catch (error) {
        console.error("Error fetching pending transactions:", error);
        return [];
    }
};


// Function to update user balance
// const updateBalance = async (username, amount) => {
//     const db = getDb();
//     const result = await db.collection(USERS_COLLECTION).updateOne(
//         { username },
//         { $inc: { balance: amount } } // Increment or decrement the user's balance by the given amount
//     );
//     return result.modifiedCount > 0; // Returns true if the update was successful
// };

const updateBalance = async (username, amount) => {
    const db = getDb();

    // Retrieve current balance and version
    const user = await db.collection(USERS_COLLECTION).findOne({ username });

    if (!user) {
        throw new Error('User not found.');
    }

    const { balance, version } = user;

    // Attempt to update the balance using optimistic locking
    const updateResult = await db.collection(USERS_COLLECTION).updateOne(
        { username, version },  // Ensure version hasn't changed
        { $inc: { balance: amount }, $set: { version: version + 1 } }  // Increment version
    );

    if (updateResult.modifiedCount === 0) {
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
    
    // Deduct from sender and add to receiver
    await updateBalance(username, -amount);
    await updateBalance(toUsername, amount);
    
    // Create a 'send' transaction
    const transactionId = await createTransaction(username, toUsername, amount, 'approved');
    
    return `Transaction successful. Transaction ID: ${transactionId}`;
};

// Request money from another user
const requestMoney = async (username, toUsername, amount) => {
    if (amount <= 0) {
        return `Invalid amount. Please enter a positive number.`;
    }
    
    // Create a 'request' transaction with status 'pending'
    const transactionId = await createTransaction(username, toUsername, amount, 'pending');
    
    return `Money request sent successfully. Transaction ID: ${transactionId}`;
};

// View pending requests for a user
const viewRequests = async (username) => {
    const requests = await getPendingRequestsForUser(username);
    
    if (requests.length === 0) {
        return `No pending requests.`;
    } else {
        // let response = `Pending Requests:\n`;
        // requests.forEach(request => {
        //     response += `Transaction ID: ${request.transactionId}, From: ${request.fromUsername}, Amount: $${request.amount}\n`;
        // });
        return requests;
    }
};

// Approve or reject a money request
const approveRequest = async (username, transactionId, approval) => {
    const request = await getTransactionById(transactionId);
    
    // if (!request || request.toUsername !== username) {
    //     return `Request not found or you don't have permission to approve it.`;
    // }

    
    if (approval === 'approve') {
        const balance = await getBalance(username);
        
        if (balance < request.amount) {
            return `Insufficient balance to approve this request.`;
        }
        
        // Deduct from the user's balance and add to the requester’s balance
        await updateBalance(username, -request.amount);
        await updateBalance(request.toUsername, request.amount);
        
        await updateTransactionStatus(transactionId, 'approved');
        
        return `Request approved. Transaction ID: ${transactionId} Amount: $ ${request.amount}.`;
    } else if (approval === 'reject') {
        await updateTransactionStatus(transactionId, 'rejected');
        return `Request rejected. Transaction ID: ${transactionId}`;
    } else {
        return `Invalid approval option. Use "approve" or "reject".`;
    }
};

const cancelRequest = async (username, transactionId, approval) => {
    const request = await getTransactionById(transactionId);
    
    if (!request || request.fromUsername !== username) {
        return `Request not found or you don't have permission to approve it.`;
    }
    
    else if (approval === 'reject') {
        await updateTransactionStatus(transactionId, 'rejected');
        return `Request rejected. Transaction ID: ${transactionId}`;
    } 
};

// Function to get a user's balance
const getBalance = async (username) => {
    const db = getDb();
    const user = await db.collection(USERS_COLLECTION).findOne({ username });
    return user ? user.balance : 0; // Returns the balance or 0 if the user doesn't exist
};

const viewRequestsByTXID = async (transactionId) => {
    const db = getDb();
    
    try {
        // Query the database to find the transaction with the specified transaction ID
        const transaction = await db.collection(TRANSACTIONS_COLLECTION).findOne({
            transactionId: transactionId
        });

        // Log the fetched transaction details (for debugging)
        console.log("Fetched transaction:", transaction);

        // Return the transaction or null if not found
        return transaction || null;
        
    } catch (error) {
        console.error("Error fetching transaction by ID:", error);
        throw error;
    }
};


module.exports = { createTransaction, getTransactionById, updateTransactionStatus, getPendingRequestsForUser, sendMoney, requestMoney, viewRequests, approveRequest, cancelRequest, updateBalance, viewRequestsByTXID };
