const net = require('net');
const bcrypt = require('bcrypt');
const readline = require('readline');
const path = require('path');
const tls = require('tls');
const dotenv = require('dotenv');
dotenv.config({path:path.join(__dirname, 'config', '.env')})
const {initializeDb }= require('./config/db');
const { getUser, createUser, updateUserRole, deposit, withdraw, getBalance, ensureAdminUser } = require('./modules/users');
const { sendMoney, requestMoney, viewRequests, approveRequest, viewRequestsByTXID, cancelRequest } = require('./modules/transaction');
const { restart } = require('pm2');

const PORT = 6201;

const ensureAdmin = async () => {
    await ensureAdminUser();
    console.log("Admin user ensured.");
};

// Later in the code
const options = {
    key: fs.readFileSync(path.join(__dirname, '../ssl/', 'key.pem')),
    cert: fs.readFileSync(path.join(__dirname, '../ssl/', 'cert.pem')),
};


const server = tls.createServer(options, (socket) => {
    let username = null;
    let role = null;

    socket.write('Welcome to AlphaBank!\nAlphaBank> ');

    const rl = readline.createInterface({ input: socket, output: socket });
    
    rl.on('line', async (input) => {
        const [command, ...args] = input.trim().split(' ');

        // await ensureAdminUser();
        if (!username && command !== 'login') {
            socket.write('Please log in first using the "login <username> <password>" command.\nAlphaBank> ');
            return;
        }

        // Function to validate user role before executing the command
        // const validateRole = async () => {
        //     if (username) {
        //         // Re-fetch the user to ensure their role is up to date
        //         const user = await getUser(username);
        //         role = user.role; // Update the role if changed
        //     }
        //     return role;
        // };

        const validateRole = async () => {
            if (username) {
                // Fetch the latest user data from the database to ensure role is up to date
                const user = await getUser(username);
                if (user) {
                    role = user.role; // Update role immediately
                    
                } else {
                    socket.write('User not found or session expired. Please log in again.\nAlphaBank> ');
                    username = null; // Reset session
                }
                return role;
            }
        };
        if (command === 'help') {
            // Display all available commands and their descriptions
            socket.write(
                `Available commands:\n` +
                `=======================================================================\n` +
                `login <username> <password> - Log in with your username and password\n` +
                `balance - Check your balance\n` +
                `send <username> <amount> - Send money to another user\n` +
                `request <username> <amount> - Request money from another user\n` +
                `approve <transaction_id> - Approve a requested transaction\n` +
                `promote <username> - Promote a user (Admin only)\n` +
                `demote <username> - Demote a user (Admin only)\n` +
                `enroll <username> <password> [role] - Create a new user (Admin and Teller only)\n` +
                `viewpending - View pending transactions\n` +
                `help - Show this help message\n` +  
                `clear - Clear the screen\n` + 
                `=======================================================================\n` +
                `AlphaBank(${username || ''}:${role || ''})> `
            );
        }

        else if (command === 'clear') {
            // Clear the screen by sending ANSI escape code
            socket.write('\x1Bc'); // This ANSI code clears most terminal screens
            socket.write(`AlphaBank(${username || ''}:${role || ''})> `);
        }
        else if (command === 'login') {
            // Ensure args contains at least two elements: username and password
            if(username){
                socket.write(`You are already logged in as ${username}\nAlphaBank(${username}:${role})>`);
                return;
            }
            if (args.length < 2) {
                socket.write(`Please provide both username and password in the format: login <username> <password>\nAlphaBank(${username}:${role})> `);
                return;
            }
        
            const inputUsername = args[0];
            const password = args[1];
        
            // Handle admin or user login by verifying username and password
            const user = await getUser(inputUsername);
            console.log(user);
            if (user && bcrypt.compareSync(password, user.password)) {
                console.log(user);
                username = inputUsername;
                role = user.role;
                socket.write(`Login successful! Welcome, ${username}.\nAlphaBank(${username}:${role})> `);
            } else {
                socket.write('Login failed.\nAlphaBank> ');
            }
        }
        
        
        else if (command === 'enroll' && ((await validateRole()) === 'Admin' || (await validateRole()) === 'Teller'))
        {
            // Only allow admins to create new users
            const [newUsername, newPassword, newRole = 'User'] = args; // Default role to 'User'
            if (!newUsername || !newPassword) {
                socket.write(`Usage: enroll <username> <password> [role]\nAlphaBank(${username}:${role})> `);
                return;
            }
            const existingUser = await getUser(newUsername);
            if (existingUser) {
                socket.write(`User ${newUsername} already exists.\nAlphaBank(${username}:${role})> `);
            } else {
                await createUser(newUsername, newPassword, newRole);
                socket.write(`User ${newUsername} created successfully with role ${newRole}.\nAlphaBank(${username}:${role})> `);
            }

        } 
        else if (command === 'promote' && (await validateRole()) === 'Admin') {
            // Only allow admins to promote a user
            const [targetUsername] = args;
            if (!targetUsername) {
                socket.write(`Usage: promote <username>\nAlphaBank(${username}:${role})> `);
                return;
            }
            const targetUser = await getUser(targetUsername);
            if (!targetUser) {
                socket.write(`User ${targetUsername} not found.\nAlphaBank(${username}:${role})> `);
                return;
            }

            // Logic for promoting user role
            let newRole;
            if (targetUser.role === 'User') {
                newRole = 'Teller';
            } else if (targetUser.role === 'Teller') {
                newRole = 'Admin';
            } else {
                socket.write(`User ${targetUsername} is already an Admin, cannot promote further.\nAlphaBank(${username}:${role})> `);
                return;
            }

            // Update the user's role in the database
            try {
                const result = await updateUserRole(targetUsername, newRole, username);
                console.log(result)
                if (result.success) {
                    socket.write(`User ${targetUsername} has been promoted to ${newRole}.\nAlphaBank(${username}:${role})> `);
                } else {
                    socket.write(result.message + `\nAlphaBank(${username}:${role})> `);  // Use the error message from updateUserRole
                }
            } catch (err) {
                console.error('Error updating user role:', err);
                socket.write('An error occurred while updating the user role. Please try again.\nAlphaBank(${username}:${role})> ');
            }

        
        } else if (command === 'demote' && (await validateRole()) === 'Admin') {
            // Only allow admins to demote a user
            const [targetUsername] = args;
            if (!targetUsername) {
                socket.write(`Usage: demote <username>\nAlphaBank(${username}:${role})> `);
                return;
            }
            const targetUser = await getUser(targetUsername);
            if (!targetUser) {
                socket.write(`User ${targetUsername} not found.\nAlphaBank(${username}:${role})> `);
                return;
            }

            // Logic for demoting user role
            let newRole;
            if (targetUser.role === 'Admin') {
                newRole = 'Teller';
            } else if (targetUser.role === 'Teller') {
                newRole = 'User';
            } else {
                socket.write(`User ${targetUsername} is already a User, cannot demote further.\nAlphaBank(${username}:${role})> `);
                return;
            }
            try {
                const result = await updateUserRole(targetUsername, newRole, username);
                
                if (result.success) {
                    socket.write(`User ${targetUsername} has been demoted to ${newRole}.\nAlphaBank(${username}:${role})> `);
                } else {
                    socket.write(result.message + `\nAlphaBank(${username}:${role})> `);  // Use the error message from updateUserRole
                }
            } catch (err) {
                console.error('Error updating user role:', err);
                socket.write('An error occurred while updating the user role. Please try again.\nAlphaBank(${username}:${role})> ');
            }
            
        } 
        else if (command === 'deposit' && ((await validateRole()) === 'Admin' || (await validateRole()) === 'Teller') ) {
            const [targetUsername, amount] = args;
            if (!targetUsername || isNaN(amount)) {
                socket.write(`Usage: deposit <username> <amount>\nAlphaBank(${username}:${role})> `);
                return;
            }
            const response = await deposit(targetUsername, parseFloat(amount));
            socket.write(`${response}\nAlphaBank(${username}:${role})> `);
        } else if (command === 'withdraw' && ((await validateRole()) === 'Admin' || (await validateRole()) === 'Teller')) {
            const [targetUsername, amount] = args;
            if (!targetUsername || isNaN(amount)) {
                socket.write(`Usage: withdraw <username> <amount>\nAlphaBank(${username}:${role})> `);
                return;
            }
            const response = await withdraw(targetUsername, parseFloat(amount));
            socket.write(`${response}\nAlphaBank(${username}:${role})> `);
        }
        else if (command === 'balance') {
            // Handle balance checks based on role
            await validateRole();
            if (role === 'Teller' || role =='Admin') {
                const [targetUsername] = args;
                if (!targetUsername) {
                    socket.write(`Usage for Tellers: balance <username>\nAlphaBank(${username}:${role})> `);
                    return;
                }
                const balance = await getBalance(targetUsername);
                if (balance !== null) {
                    socket.write(`Balance for ${targetUsername}: $${balance}\nAlphaBank(${username}:${role})> `);
                } else {
                    socket.write(`User ${targetUsername} not found.\nAlphaBank(${username}:${role})> `);
                }
            } else if (role === 'User') {
                // Regular users can only check their own balance
                const balance = await getBalance(username);
                socket.write(`Your balance: $${balance}\nAlphaBank(${username}:${role})> `);
            } else {
                await validateRole();
                socket.write(`Command not recognized or insufficient privileges.\nAlphaBank(${username}:${role})> `);
            }
        }
        else if (command === 'send' && await validateRole() && (role === 'Admin' || role === 'Teller' || role === 'User')) {
            const [recipientUsername, amount] = args;
        
            // Validate recipient username and amount input
            if (!recipientUsername || !/^[a-zA-Z0-9_]+$/.test(recipientUsername)) {
                socket.write(`Usage: send <username> <amount>\nAlphaBank(${username}:${role})> `);
                return;
            }
        
            // Validate amount: check if it's a positive number, not negative or too large
            if (!amount || isNaN(amount) || parseFloat(amount) <= 0 || !/^\d+(\.\d{1,2})?$/.test(amount)) {
                socket.write(`Usage: send <username> <amount>\nThe amount should be a positive number with up to 2 decimal places.\nAlphaBank(${username}:${role})> `);
                return;
            }
        
            const senderBalance = await getBalance(username);
            const amountToSend = parseFloat(amount);
        
            // Ensure the sender has sufficient balance
            if (senderBalance < amountToSend) {
                socket.write(`Insufficient funds. Your balance is $${senderBalance}.\nAlphaBank(${username}:${role})> `);
                return;
            }
        
            // Add the transaction to pending state
            const response = await sendMoney(username, recipientUsername, amountToSend);
            socket.write(`Transaction of $${amount} sent to ${recipientUsername}. \n(${response})\nAlphaBank(${username}:${role})> `);
        }
        else if (command === 'request' && await validateRole() && (role === 'Admin' || role === 'Teller' || role === 'User')) {
            const [toUsername, amount] = args;
        
            // Validate recipient username and amount input
            if (!toUsername || !/^[a-zA-Z0-9_]+$/.test(toUsername)) {
                socket.write(`Usage: request <username> <amount>\nAlphaBank(${username}:${role})> `);
                return;
            }
        
            // Validate amount: check if it's a positive number, not negative or too large
            if (!amount || isNaN(amount) || parseFloat(amount) <= 0 || !/^\d+(\.\d{1,2})?$/.test(amount)) {
                socket.write(`Usage: request <username> <amount>\nThe amount should be a positive number with up to 2 decimal places.\nAlphaBank(${username}:${role})> `);
                return;
            }
        
            // Call the requestMoney function to handle the request
            const response = await requestMoney( toUsername, username, parseFloat(amount));
        
            // Send the response back to the user
            socket.write(`${response}\nAlphaBank(${username}:${role})> `);
        }
        
        else if (command === 'approve' && await validateRole() && (role === 'Admin' || role === 'Teller' || role === 'User')) {
            const [transactionId] = args;
            if (!transactionId) {
                socket.write(`Usage: approve <transaction_id>\nAlphaBank(${username}:${role})> `);
                return;
            }
            const transaction = await viewRequestsByTXID(transactionId);
            console.log(transaction);
            if (!transaction) {
                socket.write(`Transaction not found.\nAlphaBank(${username}:${role})> `);
                return;
            }
            if (transaction[0].status === 'pending' && transaction[0].fromUsername == username ) {
                const response = await approveRequest(username, transactionId);

                socket.write(`${response}.\nAlphaBank(${username}:${role})> `);
            }
            else if (transaction[0].status === 'pending' && (transaction[0].fromUsername !== username )) {
                socket.write(`Illegal Activity logged.\nAlphaBank(${username}:${role})> `);
            }
            else {
                socket.write(`Transaction ${transactionId} is already approved or completed.\nAlphaBank(${username}:${role})> `);
            }
        }
        else if (command === 'reject' && await validateRole() && (role === 'Admin' || role === 'Teller' || role === 'User')) {
            const [transactionId] = args;
            if (!transactionId) {
                socket.write(`Usage: reject <transaction_id>\nAlphaBank(${username}:${role})> `);
                return;
            }
            const transaction = await viewRequestsByTXID(transactionId);
            console.log(transaction[0].status);
            if (!transaction) {
                socket.write(`Transaction not found.\nAlphaBank(${username}:${role})> `);
                return;
            }
            if (transaction[0].status === 'pending' && transaction[0].fromUsername == username) {
                const response = await cancelRequest(username, transactionId,'reject');

                socket.write(`${response}.\nAlphaBank(${username}:${role})> `);
            }
            else if (transaction[0].status === 'pending' && (transaction[0].fromUsername !== username )) {
                socket.write(`Illegal Activity logged.\nAlphaBank(${username}:${role})> `);
            }  
            else {
                socket.write(`Transaction ${transactionId} is already approved or completed.\nAlphaBank(${username}:${role})> `);
            }
        }
        else if (command === 'viewpending' && await validateRole() && (role === 'Admin' || role === 'Teller' || role === 'User')) {
            let pendingTransactions = []
            pendingTransactions = await viewRequests(username);
            console.log(pendingTransactions); 
            console.log("Is Array:", Array.isArray(pendingTransactions));
        
            // Ensure pendingTransactions is an array before calling .forEach()
            if (!Array.isArray(pendingTransactions) || pendingTransactions.length === 0) {
                socket.write(`No pending transactions.\nAlphaBank(${username}:${role})> `);
            } else {
                socket.write(`Pending transactions:\n`);
                pendingTransactions.forEach(tx => {
                    socket.write(`Transaction ID: ${tx.transactionId}, Request of Amount: $${tx.amount} from ${tx.toUsername}, Status: ${tx.type}\n`);
                });
            }
        
            socket.write(`AlphaBank(${username}:${role})> `);
        }        
        else {
            await validateRole();
            socket.write(`Command not recognized or insufficient privileges.\nAlphaBank(${username}:${role})> `);
        }
    });



    socket.on('close', () => {
        console.log(`Client ${username || 'unknown'} disconnected`);
    });
});

// Initialize database and start server
initializeDb().then(() => {
    ensureAdmin();
    server.listen(PORT, () => {
        console.log(`AlphaBank Server running on port ${PORT}`);
    });
}).catch((err) => {
    console.error('Failed to initialize database:', err);
});

