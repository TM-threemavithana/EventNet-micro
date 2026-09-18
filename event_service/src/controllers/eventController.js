const pool = require("../db/db");

exports.createEvent = async (req, res) => {
  try {
    const {
      title,
      description,
      category,
      venue,
      event_date,
      event_time,
      organizer_name,
      status,
      image_url
    } = req.body;

    const result = await pool.query(
      `INSERT INTO events 
      (title, description, category, venue, event_date, event_time, organizer_name, status, image_url)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING *`,
      [title, description, category, venue, event_date, event_time, organizer_name, status || "ACTIVE", image_url]
    );

    await publishEvent("event.created", { eventId: result.rows[0].id, title });

    res.status(201).json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ message: "Failed to create event", error: error.message });
  }
};

exports.getAllEvents = async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM events ORDER BY created_at DESC");
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ message: "Failed to fetch events", error: error.message });
  }
};

exports.getEventById = async (req, res) => {
  try {
    const { id } = req.params;

    const eventResult = await pool.query(
      "SELECT * FROM events WHERE id = $1",
      [id]
    );

    if (eventResult.rows.length === 0) {
      return res.status(404).json({ message: "Event not found" });
    }

    const ticketTypesResult = await pool.query(
      "SELECT * FROM ticket_types WHERE event_id = $1 ORDER BY id ASC",
      [id]
    );

    res.status(200).json({
      event: eventResult.rows[0],
      ticketTypes: ticketTypesResult.rows,
    });
  } catch (error) {
    console.error("Error fetching event details:", error.message);
    res.status(500).json({ message: "Failed to fetch event details" });
  }
};

exports.updateEvent = async (req, res) => {
  try {
    const { id } = req.params;
    const {
      title,
      description,
      category,
      venue,
      event_date,
      event_time,
      organizer_name,
      status,
      image_url
    } = req.body;

    const result = await pool.query(
      `UPDATE events
       SET title = $1,
           description = $2,
           category = $3,
           venue = $4,
           event_date = $5,
           event_time = $6,
           organizer_name = $7,
           status = $8,
           image_url = $9
       WHERE id = $10
       RETURNING *`,
      [title, description, category, venue, event_date, event_time, organizer_name, status, image_url, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ message: "Event not found" });
    }

    await publishEvent("event.updated", { eventId: id, title });

    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ message: "Failed to update event", error: error.message });
  }
};

exports.deleteEvent = async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query("DELETE FROM events WHERE id = $1 RETURNING *", [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ message: "Event not found" });
    }

    res.json({ message: "Event deleted successfully" });
  } catch (error) {
    res.status(500).json({ message: "Failed to delete event", error: error.message });
  }
};

exports.searchEvents = async (req, res) => {
  try {
    const { category, venue, date, status } = req.query;

    let query = "SELECT * FROM events WHERE 1=1";
    const values = [];
    let index = 1;

    if (category) {
      query += ` AND category ILIKE $${index}`;
      values.push(`%${category}%`);
      index++;
    }

    if (venue) {
      query += ` AND venue ILIKE $${index}`;
      values.push(`%${venue}%`);
      index++;
    }

    if (date) {
      query += ` AND event_date = $${index}`;
      values.push(date);
      index++;
    }

    if (status) {
      query += ` AND status ILIKE $${index}`;
      values.push(status);
      index++;
    }

    query += " ORDER BY event_date ASC, event_time ASC";

    const result = await pool.query(query, values);

    res.status(200).json(result.rows);
  } catch (error) {
    console.error("Error searching events:", error.message);
    res.status(500).json({
      message: "Failed to search events",
      error: error.message,
    });
  }
};