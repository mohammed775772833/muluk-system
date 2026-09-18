const express = require('express');
const pool = require('../../db');
const { authenticateToken, requirePermission } = require('../middleware/auth');

const router = express.Router();

// GET all employees
router.get('/', authenticateToken, requirePermission('EMPLOYEES_VIEW'), async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        employee_id,
        employee_no,
        full_name,
        phone,
        job_title,
        hire_date,
        qualification,
        skills,
        is_active,
        created_at,
        updated_at
      FROM employees
      ORDER BY employee_id
    `);

    res.json({
      success: true,
      count: result.rows.length,
      employees: result.rows
    });

  } catch (error) {
    console.error('Get employees error:', error);

    res.status(500).json({
      success: false,
      message: 'Failed to get employees'
    });
  }
});

// GET one employee
router.get('/:id', authenticateToken, requirePermission('EMPLOYEES_VIEW'), async (req, res) => {
  try {
    const { id } = req.params;

    const result = await pool.query(`
      SELECT
        employee_id,
        employee_no,
        full_name,
        phone,
        job_title,
        hire_date,
        qualification,
        skills,
        is_active,
        created_at,
        updated_at
      FROM employees
      WHERE employee_id = $1
    `, [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Employee not found'
      });
    }

    res.json({
      success: true,
      employee: result.rows[0]
    });

  } catch (error) {
    console.error('Get employee error:', error);

    res.status(500).json({
      success: false,
      message: 'Failed to get employee'
    });
  }
});

// CREATE employee
router.post('/', authenticateToken, requirePermission('EMPLOYEES_MANAGE'), async (req, res) => {
  try {
    const {
      employee_no,
      full_name,
      phone,
      job_title,
      hire_date,
      qualification,
      skills,
      is_active
    } = req.body;

    if (!employee_no || !full_name) {
      return res.status(400).json({
        success: false,
        message: 'employee_no and full_name are required'
      });
    }

    const result = await pool.query(`
      INSERT INTO employees
        (
          employee_no,
          full_name,
          phone,
          job_title,
          hire_date,
          qualification,
          skills,
          is_active
        )
      VALUES
        ($1, $2, $3, $4, $5, $6, $7, COALESCE($8, true))
      RETURNING
        employee_id,
        employee_no,
        full_name,
        phone,
        job_title,
        hire_date,
        qualification,
        skills,
        is_active,
        created_at,
        updated_at
    `, [
      employee_no.trim(),
      full_name.trim(),
      phone || null,
      job_title || null,
      hire_date || null,
      qualification || null,
      skills || null,
      is_active
    ]);

    res.status(201).json({
      success: true,
      message: 'Employee created successfully',
      employee: result.rows[0]
    });

  } catch (error) {
    console.error('Create employee error:', error);

    if (error.code === '23505') {
      return res.status(409).json({
        success: false,
        message: 'Employee number already exists'
      });
    }

    res.status(500).json({
      success: false,
      message: 'Failed to create employee'
    });
  }
});

// UPDATE employee
router.patch('/:id', authenticateToken, requirePermission('EMPLOYEES_MANAGE'), async (req, res) => {
  try {
    const { id } = req.params;

    const {
      employee_no,
      full_name,
      phone,
      job_title,
      hire_date,
      qualification,
      skills,
      is_active
    } = req.body;

    if (!employee_no || !full_name) {
      return res.status(400).json({
        success: false,
        message: 'employee_no and full_name are required'
      });
    }

    const result = await pool.query(`
      UPDATE employees
      SET
        employee_no = $1,
        full_name = $2,
        phone = $3,
        job_title = $4,
        hire_date = $5,
        qualification = $6,
        skills = $7,
        is_active = COALESCE($8, is_active)
      WHERE employee_id = $9
      RETURNING
        employee_id,
        employee_no,
        full_name,
        phone,
        job_title,
        hire_date,
        qualification,
        skills,
        is_active,
        created_at,
        updated_at
    `, [
      employee_no.trim(),
      full_name.trim(),
      phone || null,
      job_title || null,
      hire_date || null,
      qualification || null,
      skills || null,
      is_active,
      id
    ]);

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Employee not found'
      });
    }

    res.json({
      success: true,
      message: 'Employee updated successfully',
      employee: result.rows[0]
    });

  } catch (error) {
    console.error('Update employee error:', error);

    if (error.code === '23505') {
      return res.status(409).json({
        success: false,
        message: 'Employee number already exists'
      });
    }

    res.status(500).json({
      success: false,
      message: 'Failed to update employee'
    });
  }
});

module.exports = router;
