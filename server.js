require('dotenv').config();

const express = require('express');
const cors = require('cors');
const pool = require('./db');

const authRoutes = require('./src/routes/auth');
const customerRoutes = require('./src/routes/customers');
const vehicleRoutes = require('./src/routes/vehicles');
const workOrderRoutes = require('./src/routes/work-orders');
const receiptRoutes = require('./src/routes/receipts');
const serviceRoutes = require('./src/routes/services');
const risksOpportunitiesRoutes = require('./src/routes/risks-opportunities');
const inventoryRoutes = require('./src/routes/inventory');
const materialRoutes = require('./src/routes/materials');
const branchRoutes = require('./src/routes/branches');
const employeeRoutes = require('./src/routes/employees');
const userRoutes = require('./src/routes/users');
const employeePieceworkRoutes = require('./src/routes/employee-piecework');
const employeeFinanceRoutes = require('./src/routes/employee-finance');
const qualityRoutes = require('./src/routes/quality');
const qualityReportsRoutes = require('./src/routes/quality-reports');
const correctiveActionRoutes = require('./src/routes/corrective-actions');
const whatsappRoutes = require('./src/routes/whatsapp');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Frontend Static Files (وضعناها في المقدمة لضمان فتح الصفحات)
app.use(express.static('public'));
app.use('/uploads', express.static('uploads'));

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/customers', customerRoutes);
app.use('/api/vehicles', vehicleRoutes);
app.use('/api/work-orders', workOrderRoutes);
app.use('/api/receipts', receiptRoutes);
app.use('/api/services', serviceRoutes);
app.use('/api/risks-opportunities', risksOpportunitiesRoutes);
app.use('/api/inventory', inventoryRoutes);
app.use('/api/materials', materialRoutes);
app.use('/api/branches', branchRoutes);
app.use('/api/employees', employeeRoutes);
app.use('/api/users', userRoutes);
app.use('/api/employee-piecework', employeePieceworkRoutes);
app.use('/api/employee-finance', employeeFinanceRoutes);
app.use('/api/quality', qualityRoutes);
app.use('/api/quality-reports', qualityReportsRoutes);
app.use('/api/corrective-actions', correctiveActionRoutes);
app.use('/api/whatsapp', whatsappRoutes);

app.get('/', (req, res) => {
    res.sendFile(__dirname + '/public/index.html');
});

// Health Check
app.get('/api/health', async (req, res) => {
    try {
        const result = await pool.query('SELECT current_database(), current_user');
        res.json({
            success: true,
            status: 'OK',
            message: 'Backend is healthy',
            database: result.rows[0]
        });
    } catch (error) {
        console.error('Database error:', error);
        res.status(500).json({ success: false, status: 'ERROR', message: 'Database connection failed' });
    }
});

// Start Server
app.listen(PORT, '0.0.0.0', () => {
    console.log('=================================');
    console.log('Muluk QMS Backend');
    console.log(`Server running on port ${PORT}`);
    console.log(`http://localhost:${PORT}`);
    console.log('=================================');
});
